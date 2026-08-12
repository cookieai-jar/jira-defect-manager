/**
 * The IO half of the defect↔code correlation: reads a *read-only* git checkout
 * of the product monorepo and turns its commit history into `TicketCodeLink`s.
 *
 * Two hard rules shape this file:
 *
 * 1. **Never touch the source repo.** Only `rev-parse`, `log`, `rev-list` and a
 *    plain file read of CODEOWNERS. No fetch, no checkout, no writes.
 * 2. **One git process, streamed.** The naive implementation runs `git log
 *    --grep=<key>` once per ticket; at ~1300 defect tickets that is 1300
 *    process spawns and several minutes. Instead we take a single pass over
 *    the log, filtered server-side by an ERE covering every project prefix in
 *    the population, and index commits by the keys found in their messages.
 *    The child's stdout is consumed incrementally so a 15k-commit log with
 *    `--name-only` never lands in memory all at once.
 *
 * Commands are built as argv arrays and run without a shell — ticket keys and
 * repo paths are never interpolated into a command line.
 */

import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  buildCorrelation,
  emptyCorrelation,
  extractIssueKeys,
  isTestFile,
  normalizePath,
  ownerLookup,
  parseCodeowners,
  type CodeownersRule,
  type ExistsAtHead,
} from "@/lib/code-correlation";
import type { CodeCorrelation, FixCommit, TicketCodeLink } from "@/types/product-defects";

const execFileAsync = promisify(execFile);

/** ASCII record/unit separators. Neither occurs in real commit messages. */
const RS = "\x1e";
const US = "\x1f";

const DEFAULT_SINCE_DAYS = 500;
/** Hard ceiling on files retained from one commit, so a tree-wide sweep (a
 *  generated-code regen, a license header bump) cannot blow up the heap. */
const MAX_FILES_PER_COMMIT = 5000;
/** How often to fire `onProgress` while streaming. */
const PROGRESS_EVERY = 100;

/** CODEOWNERS lives in one of three places; GitHub checks them in this order. */
const CODEOWNERS_LOCATIONS = ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"];

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Is `repoPath` a readable git working tree? */
async function isGitRepo(repoPath: string): Promise<boolean> {
  if (!repoPath || typeof repoPath !== "string") return false;
  try {
    await execFileAsync("git", ["-C", repoPath, "rev-parse", "--git-dir"], {
      timeout: 15_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * HEAD sha of the analyzed repo, recorded on the correlation so a report can
 * be reproduced later. `null` when the path is not a git repo.
 */
export async function repoHead(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
      timeout: 15_000,
    });
    const sha = stdout.trim();
    return sha || null;
  } catch (err) {
    console.warn(`[code-correlation] cannot read HEAD of ${repoPath}: ${errMessage(err)}`);
    return null;
  }
}

/**
 * Read and parse the repo's CODEOWNERS. Returns `[]` (everything unowned)
 * rather than throwing when the file is absent — a repo without CODEOWNERS
 * still produces useful file/area hotspots.
 */
export async function readCodeowners(repoPath: string): Promise<CodeownersRule[]> {
  for (const rel of CODEOWNERS_LOCATIONS) {
    try {
      const text = await readFile(path.join(repoPath, rel), "utf8");
      return parseCodeowners(text);
    } catch {
      // try the next location
    }
  }
  console.warn(`[code-correlation] no CODEOWNERS found under ${repoPath}`);
  return [];
}

/**
 * Snapshot every path that exists at HEAD, in **one** git process.
 *
 * Hotspots come from up to 500 days of history, so plenty of hot paths have
 * since been renamed, split or deleted — `controlp/internal/lifecycle_management`
 * is the motivating example: it is genuinely unowned by CODEOWNERS *because it
 * no longer exists*. Reporting that as an ownership gap sends a team to adopt a
 * directory that is not there.
 *
 * `git ls-tree -r --name-only HEAD` costs ~50ms for the ~43k-file monorepo, so
 * we take the whole tree once and answer every hotspot from memory. Directory
 * prefixes are materialised alongside the files so an *area* hotspot
 * (`controlp/internal/graph`) can be answered by the same lookup — much cheaper
 * than prefix-scanning 43k strings per area.
 *
 * Returns `undefined` when the tree cannot be read, which makes every lookup
 * answer `undefined` ("unknown") rather than a misleading `false`.
 */
export async function pathsAtHead(repoPath: string): Promise<Set<string> | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "-c", "core.quotepath=false", "ls-tree", "-r", "--name-only", "HEAD"],
      { timeout: 120_000, maxBuffer: 256 * 1024 * 1024 },
    );
    const paths = new Set<string>();
    for (const line of stdout.split("\n")) {
      const file = line.trim();
      if (!file) continue;
      const p = normalizePath(unquotePath(file));
      paths.add(p);
      // Every ancestor directory of a tracked file also "exists".
      let cut = p.lastIndexOf("/");
      while (cut > 0) {
        const dir = p.slice(0, cut);
        if (paths.has(dir)) break; // ancestors already recorded
        paths.add(dir);
        cut = dir.lastIndexOf("/");
      }
    }
    return paths;
  } catch (err) {
    console.warn(`[code-correlation] cannot list HEAD tree of ${repoPath}: ${errMessage(err)}`);
    return undefined;
  }
}

/** Turn a HEAD snapshot into the predicate the pure layer stamps hotspots with. */
export function existsAtHeadFrom(paths: Set<string> | undefined): ExistsAtHead {
  if (!paths) return () => undefined;
  return (path: string) => paths.has(normalizePath(path));
}

/**
 * The distinct JIRA project prefixes present in a key population, e.g.
 * ["EAC", "SEC"]. Used to build one server-side `--grep` that git can apply
 * while walking the history, which is dramatically cheaper than streaming
 * every commit to us and filtering here.
 */
function projectPrefixes(issueKeys: string[]): string[] {
  const seen = new Set<string>();
  for (const raw of issueKeys) {
    const m = /^([A-Za-z][A-Za-z0-9]*)-\d+$/.exec(String(raw ?? "").trim());
    if (m) seen.add(m[1].toUpperCase());
  }
  return Array.from(seen).sort();
}

/** Undo git's C-style quoting of unusual paths. */
function unquotePath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  try {
    return JSON.parse(raw) as string;
  } catch {
    return raw.slice(1, -1);
  }
}

interface ParsedCommit {
  sha: string;
  date: string;
  subject: string;
  message: string;
  files: string[];
}

/**
 * Parse one `RS`-delimited record produced by our `--pretty` format:
 *
 *     <sha> US <iso-date> US <subject> US <body> US \n <file>\n<file>\n…
 *
 * Merge commits and commits whose diff is empty simply arrive with no file
 * lines, which is why the file section is allowed to be blank.
 */
function parseRecord(record: string): ParsedCommit | null {
  if (!record.trim()) return null;
  const parts = record.split(US);
  if (parts.length < 5) return null;

  const sha = parts[0].trim();
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return null;

  const date = parts[1].trim();
  const subject = parts[2];
  const body = parts[3];
  // The body itself may contain no US, but be defensive: everything after the
  // 4th separator up to the last one is still body, and the tail is the files.
  const filesBlob = parts.slice(4).join(US);

  const files: string[] = [];
  for (const line of filesBlob.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (files.length >= MAX_FILES_PER_COMMIT) break;
    files.push(normalizePath(unquotePath(trimmed)));
  }

  return {
    sha,
    date: date ? date.slice(0, 10) : "",
    subject: subject.trim(),
    message: `${subject}\n${body}`,
    files,
  };
}

/** Cheap pre-count so `onProgress` can report a real denominator. */
async function countCommits(
  repoPath: string,
  grep: string,
  sinceDays: number,
): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "-C",
        repoPath,
        "rev-list",
        "--count",
        `--since=${sinceDays}.days.ago`,
        "--extended-regexp",
        "--regexp-ignore-case",
        `--grep=${grep}`,
        "HEAD",
      ],
      { timeout: 120_000 },
    );
    const n = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Stream `git log` once, handing every parsed commit to `onCommit`.
 *
 * Resolves when the child exits; rejects only on a spawn failure. A non-zero
 * exit is surfaced as a warning and treated as "no more commits" so a partial
 * history still renders.
 */
function streamGitLog(
  repoPath: string,
  grep: string,
  sinceDays: number,
  onCommit: (commit: ParsedCommit) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "-C",
      repoPath,
      "-c",
      "core.quotepath=false",
      "log",
      "--no-color",
      `--since=${sinceDays}.days.ago`,
      "--name-only",
      "--extended-regexp",
      "--regexp-ignore-case",
      `--grep=${grep}`,
      `--pretty=format:${RS}%H${US}%aI${US}%s${US}%b${US}`,
      "HEAD",
    ];

    const child = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"] });

    let buffer = "";
    let stderr = "";
    let failed: Error | null = null;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      // Everything before the final RS is a complete record; the tail after it
      // is still being written, so it stays in the buffer.
      const lastIdx = buffer.lastIndexOf(RS);
      if (lastIdx <= 0) return;
      const complete = buffer.slice(0, lastIdx);
      buffer = buffer.slice(lastIdx);
      for (const record of complete.split(RS)) {
        const commit = parseRecord(record);
        if (commit) onCommit(commit);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 4000) stderr += chunk;
    });

    child.on("error", (err) => {
      failed = err instanceof Error ? err : new Error(String(err));
      reject(failed);
    });

    child.on("close", (code) => {
      if (failed) return;
      for (const record of buffer.split(RS)) {
        const commit = parseRecord(record);
        if (commit) onCommit(commit);
      }
      if (code !== 0) {
        console.warn(
          `[code-correlation] git log exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
        );
      }
      resolve();
    });
  });
}

export interface CollectOptions {
  /** History window. Default 500 days. */
  sinceDays?: number;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Shared worker: one streamed `git log` pass, indexed by issue key.
 *
 * Returns only the tickets that actually matched at least one commit — the
 * unlinked majority carries no information and would bloat the report JSON.
 */
async function collectLinks(
  repoPath: string,
  issueKeys: string[],
  owners: (p: string) => string[],
  opts: CollectOptions = {},
): Promise<TicketCodeLink[]> {
  const sinceDays = opts.sinceDays ?? DEFAULT_SINCE_DAYS;

  const wanted = new Set<string>();
  for (const raw of issueKeys ?? []) {
    const key = String(raw ?? "").trim().toUpperCase();
    if (key) wanted.add(key);
  }
  if (wanted.size === 0) return [];

  const prefixes = projectPrefixes(Array.from(wanted));
  if (prefixes.length === 0) {
    console.warn("[code-correlation] no parseable JIRA project prefixes in the population");
    return [];
  }

  if (!(await isGitRepo(repoPath))) {
    console.warn(
      `[code-correlation] ${repoPath || "(empty path)"} is not a readable git repo; skipping code correlation`,
    );
    return [];
  }

  const grep = `(${prefixes.join("|")})-[0-9]+`;
  const total = (await countCommits(repoPath, grep, sinceDays)) || 1;

  /** issueKey → sha → commit. Deduped: a commit naming N keys links to all N. */
  const byKey = new Map<string, Map<string, FixCommit>>();
  let processed = 0;

  await streamGitLog(repoPath, grep, sinceDays, (commit) => {
    processed += 1;
    if (opts.onProgress && processed % PROGRESS_EVERY === 0) {
      opts.onProgress(Math.min(processed, total), total);
    }

    const keys = new Set<string>();
    for (const prefix of prefixes) {
      for (const key of extractIssueKeys(commit.message, prefix)) {
        if (wanted.has(key)) keys.add(key);
      }
    }
    if (keys.size === 0) return;

    const fix: FixCommit = {
      sha: commit.sha,
      subject: commit.subject,
      date: commit.date,
      files: commit.files,
      touchesTests: commit.files.some(isTestFile),
    };

    for (const key of keys) {
      let shas = byKey.get(key);
      if (!shas) {
        shas = new Map();
        byKey.set(key, shas);
      }
      if (!shas.has(fix.sha)) shas.set(fix.sha, fix);
    }
  });

  opts.onProgress?.(total, total);

  const links: TicketCodeLink[] = [];
  for (const [issueKey, shas] of byKey) {
    // Newest commit first — the last fix is usually the interesting one.
    const commits = Array.from(shas.values()).sort((a, b) => b.date.localeCompare(a.date));
    const files = new Set<string>();
    const teams = new Set<string>();
    for (const commit of commits) {
      for (const file of commit.files) {
        files.add(file);
        for (const team of owners(file)) teams.add(team);
      }
    }
    links.push({
      issueKey,
      commits,
      teams: Array.from(teams).sort((a, b) => a.localeCompare(b)),
      files: Array.from(files).sort(),
    });
  }
  links.sort((a, b) => a.issueKey.localeCompare(b.issueKey));
  return links;
}

/**
 * Find every commit in the last `sinceDays` whose message references one of
 * `issueKeys`, grouped into one `TicketCodeLink` per ticket.
 *
 * Tolerant by design: a missing path, a non-git directory or a git failure
 * yields `[]` plus a `console.warn`, never a throw.
 */
export async function collectFixCommits(
  repoPath: string,
  issueKeys: string[],
  opts: CollectOptions = {},
): Promise<TicketCodeLink[]> {
  try {
    const rules = await readCodeowners(repoPath);
    return await collectLinks(repoPath, issueKeys, ownerLookup(rules), opts);
  } catch (err) {
    console.warn(`[code-correlation] collectFixCommits failed: ${errMessage(err)}`);
    return [];
  }
}

export interface BuildCodeCorrelationOptions extends CollectOptions {
  /** Size of each ranked hotspot list. Default 25. */
  topN?: number;
}

/**
 * End-to-end: read HEAD and CODEOWNERS, walk the log once, and fold the result
 * into a `CodeCorrelation`.
 *
 * Always resolves. If the repo cannot be read the caller still gets a valid
 * correlation with `linkedTickets: 0`, so the dashboard renders an honest
 * "no code signal" state instead of an error page.
 */
export async function buildCodeCorrelation(
  repoPath: string,
  issueKeys: string[],
  opts: BuildCodeCorrelationOptions = {},
): Promise<CodeCorrelation> {
  const keys = (issueKeys ?? []).map((k) => String(k ?? "").trim().toUpperCase()).filter(Boolean);

  try {
    if (!(await isGitRepo(repoPath))) {
      console.warn(
        `[code-correlation] ${repoPath || "(empty path)"} is not a readable git repo; returning an empty correlation`,
      );
      return emptyCorrelation(repoPath, new Set(keys).size);
    }

    const [head, rules, tree] = await Promise.all([
      repoHead(repoPath),
      readCodeowners(repoPath),
      pathsAtHead(repoPath),
    ]);
    const owners = ownerLookup(rules);
    const links = await collectLinks(repoPath, keys, owners, opts);

    return buildCorrelation({
      repoPath,
      repoHead: head,
      allIssueKeys: keys,
      links,
      topN: opts.topN,
      owners,
      existsAtHead: existsAtHeadFrom(tree),
    });
  } catch (err) {
    console.warn(`[code-correlation] buildCodeCorrelation failed: ${errMessage(err)}`);
    return emptyCorrelation(repoPath, new Set(keys).size);
  }
}

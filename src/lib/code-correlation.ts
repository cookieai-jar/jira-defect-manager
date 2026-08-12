/**
 * Deterministic correlation between customer-found JIRA defects and the
 * product source code — the pure half.
 *
 * Everything in this file is a pure function over plain data: no `fs`, no
 * `child_process`, no network. The git/filesystem side lives in
 * `@/lib/code-correlation-git`, which feeds this module the raw
 * `TicketCodeLink[]` and a CODEOWNERS-backed owner lookup.
 *
 * The central design decision is that hotspots rank by **distinct defect
 * count**, never by raw commit count or churn. A single sweeping refactor that
 * touches 400 files must not out-rank the one file that five separate
 * customers found five separate bugs in — the second is the signal we want.
 */

import type {
  CodeCorrelation,
  CodeHotspot,
  FixCommit,
  TeamCodeStats,
  TicketCodeLink,
} from "@/types/product-defects";

// ---------------------------------------------------------------------------
// CODEOWNERS
// ---------------------------------------------------------------------------

export interface CodeownersRule {
  /** The raw path pattern as written in CODEOWNERS, e.g. "/controlp/modules/auth/". */
  pattern: string;
  /** Owning teams/users, e.g. ["@cookieai-jar/platform-core"]. Empty means the
   *  line deliberately *clears* ownership (the repo uses this for generated
   *  files, so a later broad rule cannot claim them). */
  teams: string[];
}

/** A token that looks like a GitHub owner: `@org/team`, `@user` or an email. */
function isOwnerToken(token: string): boolean {
  if (token.startsWith("@")) return true;
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(token);
}

/**
 * Parse a CODEOWNERS file.
 *
 * - `#` starts a comment, at the start of a line or trailing after a pattern
 *   (the real repo has e.g. `…/codegen_services.tf # Don't require approval`).
 * - Blank lines are skipped.
 * - The first token is always the pattern — note that paths themselves may
 *   begin with `@` in this repo (`/frontend/src/@mds/`), so owner detection
 *   only ever applies to tokens 2..n.
 * - A line with a pattern and no owners is kept, with `teams: []`. It matches
 *   like any other rule and, under last-match-wins, clears ownership.
 *
 * Rules are returned in file order; `ownersForPath` walks them last-first.
 */
export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const tokens: string[] = [];
    for (const token of line.split(/\s+/)) {
      if (token.startsWith("#")) break; // trailing comment
      if (token) tokens.push(token);
    }
    if (tokens.length === 0) continue;

    const [pattern, ...rest] = tokens;
    rules.push({ pattern, teams: rest.filter(isOwnerToken) });
  }
  return rules;
}

function escapeRegex(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

/**
 * Translate a CODEOWNERS (gitignore-flavoured) pattern into an anchored RegExp
 * matched against a repo-root-relative POSIX path.
 *
 * Semantics implemented, verified against the real 744-line CODEOWNERS:
 * - A trailing `/` makes the pattern directory-only: it matches files beneath
 *   the directory, not a file of the same name.
 * - A pattern with no `/` other than a trailing one (`*.pb.go`) matches at any
 *   depth; anything else is anchored to the repo root, whether or not it has a
 *   leading `/` (`controlp/internal/cookiedb/awfdb` == `/controlp/...`).
 * - A pattern naming a directory without a trailing slash still covers
 *   everything under it, which is how `/controlp/pkg/api/handlers/users` owns
 *   the whole package.
 * - `*` matches within one segment, `?` matches one non-slash character, and a
 *   standalone `**` segment matches zero or more directories.
 */
function patternToRegex(pattern: string): RegExp {
  let p = pattern.trim();
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.slice(0, -1);

  // gitignore rule: a separator anywhere but the (already stripped) end anchors
  // the pattern to the root.
  const anchored = p.startsWith("/") || p.includes("/");
  if (p.startsWith("/")) p = p.slice(1);

  let body = "";
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        const atSegmentStart = i === 0 || p[i - 1] === "/";
        const end = i + 2;
        const atSegmentEnd = end >= p.length || p[end] === "/";
        if (atSegmentStart && atSegmentEnd) {
          if (end < p.length) {
            body += "(?:.*/)?"; // `a/**/b` — zero or more directories
            i = end; // skip the `**` and let the loop skip the `/`
          } else {
            body += ".*"; // trailing `**`
            i = end - 1;
          }
          continue;
        }
        body += "[^/]*"; // `**` glued inside a segment — treat as `*`
        i = end - 1;
        continue;
      }
      body += "[^/]*";
      continue;
    }
    if (c === "?") {
      body += "[^/]";
      continue;
    }
    body += escapeRegex(c);
  }

  const prefix = anchored ? "^" : "^(?:.*/)?";
  // A directory pattern only ever matches things *inside* it; a bare pattern
  // matches the path itself or anything beneath it.
  const suffix = dirOnly ? "/.*$" : "(?:/.*)?$";
  return new RegExp(prefix + body + suffix);
}

const regexCache = new Map<string, RegExp>();

function regexFor(pattern: string): RegExp {
  let re = regexCache.get(pattern);
  if (!re) {
    re = patternToRegex(pattern);
    regexCache.set(pattern, re);
  }
  return re;
}

/** Normalise a path to the repo-root-relative POSIX form CODEOWNERS matches. */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/**
 * Resolve the owners of a path: **last matching rule wins**, exactly as GitHub
 * does. Returns `[]` when nothing matches *or* when the winning rule is one of
 * the repo's deliberate owner-less lines (generated protobuf, lockfiles,
 * `BUILD.bazel`), which un-own a path claimed by an earlier broad rule.
 */
export function ownersForPath(rules: CodeownersRule[], path: string): string[] {
  const p = normalizePath(path);
  for (let i = rules.length - 1; i >= 0; i -= 1) {
    if (regexFor(rules[i].pattern).test(p)) return rules[i].teams;
  }
  return [];
}

/** Build a memoised owner lookup — CODEOWNERS matching is O(rules) per path. */
export function ownerLookup(rules: CodeownersRule[]): (path: string) => string[] {
  const cache = new Map<string, string[]>();
  return (path: string) => {
    let owners = cache.get(path);
    if (!owners) {
      owners = ownersForPath(rules, path);
      cache.set(path, owners);
    }
    return owners;
  };
}

// ---------------------------------------------------------------------------
// Issue keys
// ---------------------------------------------------------------------------

const KEY_PROJECT_RE = /^[A-Za-z][A-Za-z0-9]*$/;

/**
 * Pull JIRA issue keys out of a commit message (subject *and* body — the repo
 * puts keys in both, and squash commits often list several in the body).
 *
 * Deduped, uppercased, in first-seen order. Matching is case-insensitive so
 * `eac-123` in a branch name still counts, but the word boundaries stop
 * `XEAC-1` and `EAC-1abc` from matching.
 */
export function extractIssueKeys(message: string, project = "EAC"): string[] {
  if (!message) return [];
  const proj = project.trim();
  if (!KEY_PROJECT_RE.test(proj)) return [];
  const re = new RegExp(`\\b${proj}-(\\d+)\\b`, "gi");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of message.matchAll(re)) {
    const key = `${proj.toUpperCase()}-${m[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

// ---------------------------------------------------------------------------
// File classification
// ---------------------------------------------------------------------------

/**
 * Area label for files that sit directly at the repo root. It is a synthetic
 * bucket, not a path, so it is never looked up against the HEAD tree — the
 * repo root always exists.
 */
export const ROOT_AREA = "(root)";

const TEST_DIR_RE =/(^|\/)(__tests__|__test__|tests?|testdata|test_data|spec|e2e)(\/|$)/;
const TEST_FILE_RE =
  /(_test\.(go|py|rb|cc|cpp|java|kt|ts|tsx|js)|_spec\.(rb|js|ts)|\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)|Test\.java|Tests?\.cs)$/;
const PY_TEST_FILE_RE = /(^|\/)test_[^/]+\.py$/;

/**
 * Is this a test file? Covers the conventions actually present in the source
 * monorepo: Go `*_test.go`, TS/JS `*.test.ts(x)` / `*.spec.ts(x)`, Python
 * `*_test.py` and `test_*.py`, Java/Kotlin `*Test.java`, and anything living
 * under a `test/`, `tests/`, `__tests__/`, `spec/`, `e2e/` or `testdata/`
 * directory.
 */
export function isTestFile(path: string): boolean {
  const p = normalizePath(path);
  if (!p) return false;
  if (TEST_DIR_RE.test(p)) return true;
  if (TEST_FILE_RE.test(p)) return true;
  if (PY_TEST_FILE_RE.test(p)) return true;
  return false;
}

const LOCKFILE_RE =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|go\.sum|Cargo\.lock|poetry\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|MODULE\.bazel\.lock|[^/]*\.lock\.json|[^/]*\.lock)$/;

const GENERATED_FILE_RE =
  /(\.pb\.go|\.pb\.gw\.go|_grpc\.pb\.go|\.pb\.cc|\.pb\.h|\.pb\.swift|_pb\.ts|_pb\.js|_pb\.d\.ts|_pb2\.py|_pb2_grpc\.py|_connect\.ts|\.connect\.go|\.generated\.(go|ts|tsx|cue|json|yaml|yml)|_generated\.(go|ts)|\.gen\.go|\.g\.dart)$/;

const GENERATED_DIR_RE =
  /(^|\/)(vendor|node_modules|third_party|third-party|external|\.yarn|generated|gen|__generated__|__mocks__\/generated)(\/)/;

const OPENAPI_RE = /(^|\/)(openapi|swagger)[^/]*\.(ya?ml|json)$/i;
const PROTO_DESCRIPTOR_RE = /\.(pb|descriptor_set|binpb)$/;
const SNAPSHOT_RE = /(^|\/)__snapshots__\//;

/**
 * Noise that must not be allowed to win a hotspot ranking: lockfiles,
 * generated protobuf/connect output, generated OpenAPI specs, snapshots and
 * vendored trees. These stay in `links` (they are genuinely part of the fix
 * commit) — they are only filtered out of the ranked hotspot lists.
 */
export function isExcludedFromHotspots(path: string): boolean {
  const p = normalizePath(path);
  if (!p) return true;
  if (LOCKFILE_RE.test(p)) return true;
  if (GENERATED_FILE_RE.test(p)) return true;
  if (GENERATED_DIR_RE.test(p)) return true;
  if (OPENAPI_RE.test(p)) return true;
  if (PROTO_DESCRIPTOR_RE.test(p)) return true;
  if (SNAPSHOT_RE.test(p)) return true;
  return false;
}

/**
 * Roll a file path up to a directory "area" for area hotspots, e.g.
 * `controlp/internal/graph/graphplanner/plan.go` → `controlp/internal/graph`.
 *
 * Shallow paths collapse sensibly: a path with fewer than `depth` directories
 * uses all of them, and a file at the repo root reports `ROOT_AREA`.
 */
export function areaForPath(path: string, depth = 3): string {
  const p = normalizePath(path);
  if (!p) return ROOT_AREA;
  const parts = p.split("/").filter(Boolean);
  const dirs = parts.slice(0, -1);
  if (dirs.length === 0) return ROOT_AREA;
  const d = Math.max(1, Math.trunc(depth));
  return dirs.slice(0, d).join("/");
}

// ---------------------------------------------------------------------------
// Correlation
// ---------------------------------------------------------------------------

function uniqueKeys(keys: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of keys) {
    const key = String(raw ?? "").trim().toUpperCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function pct(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function sortedTeams(teams: Iterable<string>): string[] {
  return Array.from(new Set(teams)).sort((a, b) => a.localeCompare(b));
}

/** Deterministic hotspot ordering: distinct defects, then breadth, then path. */
function compareHotspots(a: CodeHotspot, b: CodeHotspot): number {
  if (b.defectCount !== a.defectCount) return b.defectCount - a.defectCount;
  if (b.fileCount !== a.fileCount) return b.fileCount - a.fileCount;
  return a.path.localeCompare(b.path);
}

interface Bucket {
  issueKeys: Set<string>;
  teams: Set<string>;
  files: Set<string>;
}

function bucket(map: Map<string, Bucket>, key: string): Bucket {
  let b = map.get(key);
  if (!b) {
    b = { issueKeys: new Set(), teams: new Set(), files: new Set() };
    map.set(key, b);
  }
  return b;
}

/**
 * Does a hotspot path still exist at the analyzed HEAD?
 *
 * Hotspots are derived from up to 500 days of history, so a path may since
 * have been renamed, split or deleted. Callers get this from the git layer as
 * a closure over one batched `git ls-tree` snapshot; `undefined` means "we
 * could not determine it", which is deliberately distinct from `false`.
 */
export type ExistsAtHead = (path: string) => boolean | undefined;

function toHotspots(
  map: Map<string, Bucket>,
  topN: number,
  existsAtHead?: ExistsAtHead,
): CodeHotspot[] {
  const out: CodeHotspot[] = [];
  for (const [path, b] of map) {
    const hotspot: CodeHotspot = {
      path,
      defectCount: b.issueKeys.size,
      issueKeys: Array.from(b.issueKeys).sort(),
      teams: sortedTeams(b.teams),
      fileCount: b.files.size,
    };
    if (existsAtHead) {
      // ROOT_AREA is a synthetic bucket, not a tracked path; the repo root is
      // always present, so never let it be reported as deleted.
      const exists = path === ROOT_AREA ? true : existsAtHead(path);
      if (exists !== undefined) hotspot.existsAtHead = exists;
    }
    out.push(hotspot);
  }
  out.sort(compareHotspots);
  return out.slice(0, Math.max(0, topN));
}

/**
 * Is this hotspot a genuine **ownership gap** — code that is still in the tree
 * and that CODEOWNERS does not assign to anyone?
 *
 * A path that no longer exists at HEAD is *not* an ownership gap, however
 * unowned it looks: nobody can adopt a directory that has been deleted, and
 * putting one in a report sends a team chasing a ghost. Existence must be
 * positively known — an `undefined` `existsAtHead` is not treated as present.
 */
export function isUnownedGap(hotspot: CodeHotspot): boolean {
  return hotspot.existsAtHead === true && (hotspot.teams?.length ?? 0) === 0;
}

/**
 * Existence predicates, remembered per correlation object.
 *
 * `correlationByGroup` is called by the runner as `(correlation, groups)` —
 * after the git layer has finished and with no way to pass a predicate. Keying
 * off the correlation's object identity lets the group hotspots reuse the very
 * same HEAD snapshot the parent was built from. A `WeakMap` keeps this from
 * pinning big correlations in memory, and a correlation that has been through
 * JSON (loaded from the DB on a later request) simply misses and falls back to
 * whatever its stamped hotspots already record.
 */
const existenceRegistry = new WeakMap<CodeCorrelation, ExistsAtHead>();

/**
 * Recover a partial existence predicate from a correlation's already-stamped
 * hotspots. Paths outside those ranked lists answer `undefined` — unknown, not
 * absent — so nothing gets wrongly labelled a live ownership gap or a ghost.
 */
function existenceFromHotspots(correlation: CodeCorrelation): ExistsAtHead | undefined {
  const known = new Map<string, boolean>();
  for (const list of [correlation.fileHotspots, correlation.areaHotspots]) {
    for (const h of list ?? []) {
      if (h.existsAtHead !== undefined) known.set(h.path, h.existsAtHead);
    }
  }
  if (known.size === 0) return undefined;
  return (path: string) => known.get(path);
}

/** The subset of `hotspots` that represent real, still-present ownership gaps. */
export function unownedHotspots(hotspots: CodeHotspot[]): CodeHotspot[] {
  return (hotspots ?? []).filter(isUnownedGap);
}

/** Hotspots whose path has since been renamed or deleted — stale action items. */
export function staleHotspots(hotspots: CodeHotspot[]): CodeHotspot[] {
  return (hotspots ?? []).filter((h) => h.existsAtHead === false);
}

/**
 * Fold a set of `TicketCodeLink`s into ranked file and area hotspots.
 *
 * `owners`, when supplied, resolves per-file CODEOWNERS teams and gives exact
 * team attribution. Without it we fall back to the union of the teams recorded
 * on the tickets that touched the path — coarser, but never wrong about
 * *which* tickets are involved.
 */
function hotspotsFor(
  links: TicketCodeLink[],
  topN: number,
  owners?: (path: string) => string[],
  existsAtHead?: ExistsAtHead,
): { fileHotspots: CodeHotspot[]; areaHotspots: CodeHotspot[] } {
  const byFile = new Map<string, Bucket>();
  const byArea = new Map<string, Bucket>();

  for (const link of links) {
    const issueKey = link.issueKey;
    for (const rawFile of link.files ?? []) {
      const file = normalizePath(rawFile);
      if (!file || isExcludedFromHotspots(file)) continue;
      const teams = owners ? owners(file) : (link.teams ?? []);

      const fb = bucket(byFile, file);
      fb.issueKeys.add(issueKey);
      fb.files.add(file);
      for (const t of teams) fb.teams.add(t);

      const ab = bucket(byArea, areaForPath(file));
      ab.issueKeys.add(issueKey);
      ab.files.add(file);
      for (const t of teams) ab.teams.add(t);
    }
  }

  return {
    fileHotspots: toHotspots(byFile, topN, existsAtHead),
    areaHotspots: toHotspots(byArea, topN, existsAtHead),
  };
}

interface TeamAccumulator {
  issueKeys: Set<string>;
  files: Set<string>;
  /** sha → touchesTests, deduped so a commit spanning two tickets counts once. */
  commits: Map<string, boolean>;
}

function teamStats(
  links: TicketCodeLink[],
  owners?: (path: string) => string[],
): TeamCodeStats[] {
  const acc = new Map<string, TeamAccumulator>();
  const get = (team: string): TeamAccumulator => {
    let a = acc.get(team);
    if (!a) {
      a = { issueKeys: new Set(), files: new Set(), commits: new Map() };
      acc.set(team, a);
    }
    return a;
  };

  for (const link of links) {
    const commits = link.commits ?? [];
    if (commits.length === 0) continue;

    if (owners) {
      // Exact attribution: a team only owns the files CODEOWNERS gives it, and
      // only the commits that touched at least one of those files.
      for (const commit of commits) {
        const teamsInCommit = new Set<string>();
        for (const rawFile of commit.files ?? []) {
          const file = normalizePath(rawFile);
          if (!file) continue;
          for (const team of owners(file)) {
            teamsInCommit.add(team);
            get(team).files.add(file);
          }
        }
        for (const team of teamsInCommit) {
          const a = get(team);
          a.issueKeys.add(link.issueKey);
          a.commits.set(commit.sha, commit.touchesTests || a.commits.get(commit.sha) === true);
        }
      }
    } else {
      // Fallback: attribute the whole ticket to every team it names.
      for (const team of link.teams ?? []) {
        const a = get(team);
        a.issueKeys.add(link.issueKey);
        for (const rawFile of link.files ?? []) {
          const file = normalizePath(rawFile);
          if (file) a.files.add(file);
        }
        for (const commit of commits) {
          a.commits.set(commit.sha, commit.touchesTests || a.commits.get(commit.sha) === true);
        }
      }
    }
  }

  const out: TeamCodeStats[] = [];
  for (const [team, a] of acc) {
    const commitCount = a.commits.size;
    let withTests = 0;
    for (const touches of a.commits.values()) if (touches) withTests += 1;
    out.push({
      team,
      defectCount: a.issueKeys.size,
      issueKeys: Array.from(a.issueKeys).sort(),
      fileCount: a.files.size,
      commitCount,
      testChangeRate: pct(withTests, commitCount),
    });
  }
  out.sort((x, y) => {
    if (y.defectCount !== x.defectCount) return y.defectCount - x.defectCount;
    if (y.fileCount !== x.fileCount) return y.fileCount - x.fileCount;
    return x.team.localeCompare(y.team);
  });
  return out;
}

/** Distinct commits across every link, keyed by sha. */
function distinctCommits(links: TicketCodeLink[]): Map<string, FixCommit> {
  const map = new Map<string, FixCommit>();
  for (const link of links) {
    for (const commit of link.commits ?? []) {
      if (!map.has(commit.sha)) map.set(commit.sha, commit);
    }
  }
  return map;
}

export interface BuildCorrelationInput {
  repoPath: string;
  repoHead: string | null;
  /** Every candidate defect ticket, linked or not — the link-rate denominator. */
  allIssueKeys: string[];
  links: TicketCodeLink[];
  /** Size of each ranked hotspot list. Default 25. */
  topN?: number;
  /**
   * Optional per-file CODEOWNERS resolver. Supplied by the git layer; when
   * absent, team attribution degrades to the ticket-level union recorded on
   * each `TicketCodeLink`.
   */
  owners?: (path: string) => string[];
  /**
   * Optional "does this path still exist at HEAD?" predicate, also supplied by
   * the git layer. Stamps `existsAtHead` on every ranked hotspot so the UI and
   * the report can tell a live ownership gap from a path that has since been
   * renamed or deleted.
   */
  existsAtHead?: ExistsAtHead;
}

/**
 * Assemble the full `CodeCorrelation` from a ticket population and the links
 * discovered in git.
 */
export function buildCorrelation(input: BuildCorrelationInput): CodeCorrelation {
  const topN = input.topN ?? 25;
  const allKeys = uniqueKeys(input.allIssueKeys ?? []);
  const known = new Set(allKeys);

  // Only keep links that actually found a commit, and — when we were given a
  // population — that belong to it.
  const links = (input.links ?? []).filter(
    (l) => (l.commits?.length ?? 0) > 0 && (known.size === 0 || known.has(l.issueKey)),
  );

  const linkedTickets = new Set(links.map((l) => l.issueKey)).size;
  const totalTickets = allKeys.length || linkedTickets;

  const { fileHotspots, areaHotspots } = hotspotsFor(
    links,
    topN,
    input.owners,
    input.existsAtHead,
  );

  let fixesWithTests = 0;
  let fixesWithoutTests = 0;
  for (const commit of distinctCommits(links).values()) {
    if (commit.touchesTests) fixesWithTests += 1;
    else fixesWithoutTests += 1;
  }

  const correlation: CodeCorrelation = {
    repoPath: input.repoPath,
    repoHead: input.repoHead ?? null,
    totalTickets,
    linkedTickets,
    linkRate: pct(linkedTickets, totalTickets),
    fileHotspots,
    areaHotspots,
    byTeam: teamStats(links, input.owners),
    links,
    fixesWithTests,
    fixesWithoutTests,
    byGroup: [],
  };

  // Remember the HEAD snapshot so a later correlationByGroup(correlation, …)
  // can stamp group hotspots from the same source of truth.
  if (input.existsAtHead) existenceRegistry.set(correlation, input.existsAtHead);

  return correlation;
}

/**
 * Project an existing correlation onto the defect groups produced by the AI
 * synthesis phase: for each group, where in the code that class of defect
 * actually lives.
 *
 * `topN` defaults to 10 — these lists render inside a per-group card, not the
 * full-width hotspot table.
 */
export function correlationByGroup(
  correlation: CodeCorrelation,
  groups: Array<{ key: string; issueKeys: string[] }>,
  topN = 10,
  owners?: (path: string) => string[],
  existsAtHead?: ExistsAtHead,
): CodeCorrelation["byGroup"] {
  const byKey = new Map<string, TicketCodeLink>();
  for (const link of correlation.links ?? []) byKey.set(link.issueKey, link);

  // The runner calls this with only (correlation, groups), long after the git
  // layer has gone. Recover per-path existence from the parent correlation's
  // already-stamped hotspots so group hotspots inherit the same verdict.
  const knownExistence =
    existsAtHead ?? existenceRegistry.get(correlation) ?? existenceFromHotspots(correlation);

  return (groups ?? []).map((group) => {
    const links: TicketCodeLink[] = [];
    for (const key of uniqueKeys(group.issueKeys ?? [])) {
      const link = byKey.get(key);
      if (link && (link.commits?.length ?? 0) > 0) links.push(link);
    }
    const { fileHotspots, areaHotspots } = hotspotsFor(links, topN, owners, knownExistence);
    return {
      groupKey: group.key,
      teams: sortedTeams(links.flatMap((l) => l.teams ?? [])),
      areaHotspots,
      fileHotspots,
      linkedTickets: links.length,
    };
  });
}

/** An empty correlation, for a missing repo or an empty ticket population. */
export function emptyCorrelation(repoPath: string, totalTickets = 0): CodeCorrelation {
  return {
    repoPath,
    repoHead: null,
    totalTickets,
    linkedTickets: 0,
    linkRate: 0,
    fileHotspots: [],
    areaHotspots: [],
    byTeam: [],
    links: [],
    fixesWithTests: 0,
    fixesWithoutTests: 0,
    byGroup: [],
  };
}

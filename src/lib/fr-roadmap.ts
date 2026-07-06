/**
 * Committed-roadmap model: group FRs by their "Targeted Month" and attach the
 * child EAC epics + dependency links. Pure + unit-tested; the JIRA I/O lives in
 * jira.ts and the assembly in the /api/fr/roadmap route.
 */
import type {
  CommittedRoadmap,
  CommittedMonth,
  RoadmapFr,
  RoadmapChild,
  RoadmapDependency,
} from "@/types/triage";

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface ParsedMonth {
  /** Sortable "YYYY-MM". */
  key: string;
  year: number;
  /** 0-based month. */
  monthIndex: number;
}

/**
 * PURE. Parse a "Targeted Month" option value like "Jul '26" / "Jul ’26" /
 * "July 2026" into a sortable month. Returns null when unparseable.
 */
export function parseTargetedMonth(value: string | null | undefined): ParsedMonth | null {
  if (!value) return null;
  const v = value.replace(/[’`]/g, "'").trim();
  // "Jul '26", "Jul 26", "July 2026"
  const m = v.match(/^([A-Za-z]{3,})\s*'?\s*(\d{2}|\d{4})$/);
  if (!m) return null;
  const monthIndex = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (monthIndex === undefined) return null;
  const yy = Number(m[2]);
  const year = m[2].length === 2 ? 2000 + yy : yy;
  return { key: `${year}-${String(monthIndex + 1).padStart(2, "0")}`, year, monthIndex };
}

/** PURE. The "YYYY-MM" key for a timestamp (the current month boundary). */
export function monthKeyOf(now: number): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * PURE. Classify a JIRA issue-link phrase (the inward/outward text) into a
 * dependency direction + whether it's an unresolved blocker for the source issue.
 */
export function classifyDependency(
  phrase: string,
  linkedDone: boolean,
): { direction: RoadmapDependency["direction"]; isBlocker: boolean } {
  const p = phrase.toLowerCase();
  if (p.includes("blocked by")) return { direction: "blocked-by", isBlocker: !linkedDone };
  if (p.includes("depended on by")) return { direction: "blocks", isBlocker: false };
  if (p.includes("depends on")) return { direction: "depends-on", isBlocker: !linkedDone };
  if (p.includes("blocks")) return { direction: "blocks", isBlocker: false };
  return { direction: "relates", isBlocker: false };
}

/** Planning fields we expect every committed EAC epic to have set. */
export const EAC_REQUIRED_FIELDS = ["Due Date", "Original Estimate", "Sprint"] as const;

/**
 * PURE. Which of the required EAC planning fields are unset. `originalEstimate`
 * is seconds (0/null = unset); `sprint` is JIRA's array (empty/null = unset).
 */
export function missingEacFields(v: {
  dueDate: unknown;
  originalEstimate: unknown;
  sprint: unknown;
}): string[] {
  const missing: string[] = [];
  if (!v.dueDate) missing.push("Due Date");
  if (!v.originalEstimate) missing.push("Original Estimate");
  if (!Array.isArray(v.sprint) || v.sprint.length === 0) missing.push("Sprint");
  return missing;
}

/** An Atlassian Document Format node (loose — we only build a small subset). */
type AdfNode = { type: string; [k: string]: unknown };

/**
 * PURE. Build the ADF comment body that pings the assignee to fill missing
 * planning fields. @mentions the assignee when known; otherwise asks for an
 * owner + the fields. Returns null when nothing is missing (never comment).
 */
export function buildMissingFieldsComment(opts: {
  assigneeAccountId: string | null;
  assigneeName: string | null;
  missingFields: string[];
}): { type: "doc"; version: 1; content: AdfNode[] } | null {
  if (opts.missingFields.length === 0) return null;
  const inline: AdfNode[] = [];
  if (opts.assigneeAccountId) {
    inline.push({ type: "mention", attrs: { id: opts.assigneeAccountId, text: `@${opts.assigneeName ?? "assignee"}` } });
    inline.push({ type: "text", text: " — please add the following planning field(s) so this epic can be scheduled: " });
  } else {
    inline.push({ type: "text", text: "This epic is unassigned — please assign an owner and add the following planning field(s): " });
  }
  inline.push({ type: "text", text: opts.missingFields.join(", "), marks: [{ type: "strong" }] });
  inline.push({ type: "text", text: ". (Flagged from the FR Committed Roadmap view.)" });
  return { type: "doc", version: 1, content: [{ type: "paragraph", content: inline }] };
}

/** A lightweight issue (FR or child epic) with parsed dependency links. */
export interface RoadmapIssueInput {
  key: string;
  summary: string;
  status: string;
  statusCategory: RoadmapFr["statusCategory"];
  issueType: string;
  parentKey: string | null;
  targetedMonth: string | null;
  dependencies: RoadmapDependency[];
  /** Unset planning fields (children only); [] for FRs. */
  missingFields: string[];
  assignee: { accountId: string; displayName: string } | null;
}

/**
 * PURE. Build the committed roadmap: FRs with a parseable Targeted Month grouped
 * by month (chronological), each carrying its child epics + dependency links and
 * a blocker tally. `children` are issues whose parentKey is a committed FR.
 */
export function buildCommittedRoadmap(
  frs: RoadmapIssueInput[],
  children: RoadmapIssueInput[],
  baseUrl: string,
  now: number = Date.now(),
): CommittedRoadmap {
  const browse = (key: string) => `${baseUrl.replace(/\/$/, "")}/browse/${key}`;
  const childrenByParent = new Map<string, RoadmapChild[]>();
  for (const c of children) {
    if (!c.parentKey) continue;
    const child: RoadmapChild = {
      key: c.key,
      summary: c.summary,
      status: c.status,
      statusCategory: c.statusCategory,
      type: c.issueType,
      url: browse(c.key),
      dependencies: c.dependencies,
      missingFields: c.missingFields,
      assignee: c.assignee,
    };
    const list = childrenByParent.get(c.parentKey) ?? [];
    list.push(child);
    childrenByParent.set(c.parentKey, list);
  }

  const byMonth = new Map<string, { label: string; frs: RoadmapFr[] }>();
  const dropped: { key: string; rawValue: string }[] = [];
  for (const fr of frs) {
    const parsed = parseTargetedMonth(fr.targetedMonth);
    if (!parsed) {
      // Field is set but unparseable (e.g. "H2 '26", "TBD") — surface, don't hide.
      if (fr.targetedMonth) dropped.push({ key: fr.key, rawValue: fr.targetedMonth });
      continue;
    }
    const kids = (childrenByParent.get(fr.key) ?? []).sort((a, b) => a.key.localeCompare(b.key));
    // Dedupe blockers by linked key across the FR + its children (an upstream
    // ticket blocking both the FR and its epic must not be counted twice).
    const blockerKeys = new Set<string>();
    for (const d of fr.dependencies) if (d.isBlocker) blockerKeys.add(d.key);
    for (const k of kids) for (const d of k.dependencies) if (d.isBlocker) blockerKeys.add(d.key);
    const blockerCount = blockerKeys.size;
    const row: RoadmapFr = {
      key: fr.key,
      summary: fr.summary,
      status: fr.status,
      statusCategory: fr.statusCategory,
      targetedMonth: fr.targetedMonth ?? "",
      url: browse(fr.key),
      children: kids,
      dependencies: fr.dependencies,
      blockerCount,
      incompleteChildCount: kids.filter((k) => k.missingFields.length > 0).length,
    };
    const bucket = byMonth.get(parsed.key) ?? { label: monthLabel(parsed), frs: [] };
    bucket.frs.push(row);
    byMonth.set(parsed.key, bucket);
  }

  const currentKey = monthKeyOf(now);
  const months: CommittedMonth[] = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, b]) => {
      const frsSorted = b.frs.sort((x, y) => y.blockerCount - x.blockerCount || x.key.localeCompare(y.key));
      return {
        key,
        label: b.label,
        isPast: key < currentKey,
        frs: frsSorted,
        frCount: frsSorted.length,
        childCount: frsSorted.reduce((n, f) => n + f.children.length, 0),
        blockerCount: frsSorted.reduce((n, f) => n + f.blockerCount, 0),
        incompleteChildCount: frsSorted.reduce((n, f) => n + f.incompleteChildCount, 0),
      };
    });

  return { months, dropped, generatedAt: new Date(now).toISOString() };
}

function monthLabel(p: ParsedMonth): string {
  return `${MONTH_LABELS[p.monthIndex]} '${String(p.year).slice(-2)}`;
}

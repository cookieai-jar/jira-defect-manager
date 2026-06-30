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
      };
    });

  return { months, dropped, generatedAt: new Date(now).toISOString() };
}

function monthLabel(p: ParsedMonth): string {
  return `${MONTH_LABELS[p.monthIndex]} '${String(p.year).slice(-2)}`;
}

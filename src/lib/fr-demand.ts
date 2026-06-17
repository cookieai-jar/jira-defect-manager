/**
 * FR demand insights — pure, framework-free analysis over FR rows for the PM view.
 *
 * A "row" is a TicketAnalysis enriched with its JiraIssue. We only depend on the
 * fields we read here so the module stays easy to test with minimal fixtures.
 *
 * Conventions (shared across the FR PM dashboard):
 *   - demand high  = temperatureScore >= 7
 *   - value high   = severityScore >= 7
 *   - "resolved"   = status === "resolved"  (excluded from the open set)
 *   - "in-flight"  = status === "active" || status === "blocked"
 *
 * Unless a function says otherwise it operates over the OPEN (non-resolved) rows.
 */

import type { JiraIssue, TicketAnalysis } from "@/types/triage";

export type DemandRow = TicketAnalysis & { issue: JiraIssue };

export const DEMAND_HIGH = 7;
export const VALUE_HIGH = 7;

/** Open == not resolved. */
export function isOpen(row: DemandRow): boolean {
  return row.status !== "resolved";
}

function openRows(rows: DemandRow[]): DemandRow[] {
  return rows.filter(isOpen);
}

/** Round to one decimal place, returning a finite number (0 for empty means). */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function mean(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

// ---------------------------------------------------------------------------
// 1. Theme clusters
// ---------------------------------------------------------------------------

export interface ThemeCluster {
  theme: string;
  count: number;
  avgDemand: number; // mean temperatureScore, 1dp
  avgValue: number; // mean severityScore, 1dp
  keys: string[];
}

/**
 * Pick a theme key for a row, in priority order:
 *   1. issue.components[0]
 *   2. issue.labels[0]
 *   3. parent epic summary  (only when parent.type === "Epic")
 *   4. "Uncategorized"
 */
export function themeKey(row: DemandRow): string {
  const comp = row.issue.components?.[0];
  if (comp) return comp;
  const label = row.issue.labels?.[0];
  if (label) return label;
  const parent = row.issue.parent;
  if (parent && parent.type === "Epic" && parent.summary) return parent.summary;
  return "Uncategorized";
}

/**
 * Group open rows by theme key. Sorted by count desc, then avgDemand desc.
 */
export function themeClusters(rows: DemandRow[]): ThemeCluster[] {
  const open = openRows(rows);
  const groups = new Map<string, DemandRow[]>();
  // Preserve first-seen insertion order for stable downstream tie-breaks.
  for (const r of open) {
    const key = themeKey(r);
    const bucket = groups.get(key);
    if (bucket) bucket.push(r);
    else groups.set(key, [r]);
  }

  const clusters: ThemeCluster[] = [];
  for (const [theme, members] of groups) {
    clusters.push({
      theme,
      count: members.length,
      avgDemand: round1(mean(members.map((m) => m.temperatureScore))),
      avgValue: round1(mean(members.map((m) => m.severityScore))),
      keys: members.map((m) => m.issueKey),
    });
  }

  clusters.sort((a, b) => b.count - a.count || b.avgDemand - a.avgDemand);
  return clusters;
}

// ---------------------------------------------------------------------------
// 2. Customer concentration
// ---------------------------------------------------------------------------

export interface CustomerConcentrationEntry {
  customer: string;
  count: number;
  isWhiteGlove: boolean;
  keys: string[];
}

export interface CustomerConcentration {
  entries: CustomerConcentrationEntry[];
  distinctCustomers: number;
  topCustomer: CustomerConcentrationEntry | null;
}

/**
 * Per-customer FR counts over open rows. Rows with a null/empty customer are
 * skipped. A customer is white-glove when ANY of its rows isP0Customer.
 * Sorted by count desc.
 */
export function customerConcentration(rows: DemandRow[]): CustomerConcentration {
  const open = openRows(rows);
  const groups = new Map<string, DemandRow[]>();
  for (const r of open) {
    const customer = r.customer;
    if (!customer) continue; // skips null AND empty string
    const bucket = groups.get(customer);
    if (bucket) bucket.push(r);
    else groups.set(customer, [r]);
  }

  const entries: CustomerConcentrationEntry[] = [];
  for (const [customer, members] of groups) {
    entries.push({
      customer,
      count: members.length,
      isWhiteGlove: members.some((m) => m.isP0Customer),
      keys: members.map((m) => m.issueKey),
    });
  }

  entries.sort((a, b) => b.count - a.count);

  return {
    entries,
    distinctCustomers: entries.length,
    topCustomer: entries[0] ?? null,
  };
}

// ---------------------------------------------------------------------------
// 3. Triage coverage
// ---------------------------------------------------------------------------

export interface TriageCoverage {
  total: number;
  untriaged: number;
  triaged: number;
  untriagedRows: DemandRow[];
  coveragePct: number; // triaged/total*100 rounded; 0 when total is 0
}

/**
 * An open FR is "untriaged" when it has no assignee AND is not slotted into a
 * sprint (suggestedSprint === null) — i.e. no owner and no plan. Assigned OR
 * slotted counts as triaged.
 */
export function triageCoverage(rows: DemandRow[]): TriageCoverage {
  const open = openRows(rows);
  const untriagedRows = open.filter(
    (r) => !r.issue.assignee && r.suggestedSprint === null,
  );
  const total = open.length;
  const untriaged = untriagedRows.length;
  const triaged = total - untriaged;
  const coveragePct = total === 0 ? 0 : Math.round((triaged / total) * 100);
  return { total, untriaged, triaged, untriagedRows, coveragePct };
}

// ---------------------------------------------------------------------------
// 4. Possible duplicates (heuristic)
// ---------------------------------------------------------------------------

export interface DuplicateCluster {
  keys: string[];
  sampleSummary: string;
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "when",
  "from",
  "that",
  "this",
  "not",
  "are",
  "was",
]);

export const DUPLICATE_SIMILARITY_THRESHOLD = 0.6;

/** Lowercase, split on non-alphanumerics, drop short tokens + stopwords. */
export function titleTokens(summary: string): Set<string> {
  const tokens = summary
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return new Set(tokens);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  if (union === 0) return 0;
  return intersection / union;
}

/**
 * Best-effort duplicate detection over open rows. Two FRs are considered
 * candidate duplicates when their normalized title token sets have Jaccard
 * similarity >= 0.6. Uses single-link clustering via union-find over the
 * similarity graph. Iteration order follows input order for determinism.
 * Only clusters of size >= 2 are returned. This is a heuristic, not a proof.
 */
export function possibleDuplicates(rows: DemandRow[]): DuplicateCluster[] {
  const open = openRows(rows);
  const n = open.length;
  const tokenSets = open.map((r) => titleTokens(r.issue.summary));

  // Union-find with path compression. parent[i] points toward a root.
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x: number): number {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  }
  function union(a: number, b: number) {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // Keep the lower index as root so clusters track input order.
    if (ra < rb) parent[rb] = ra;
    else parent[ra] = rb;
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (jaccard(tokenSets[i], tokenSets[j]) >= DUPLICATE_SIMILARITY_THRESHOLD) {
        union(i, j);
      }
    }
  }

  // Collect members per root, preserving input order within each cluster.
  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const bucket = byRoot.get(root);
    if (bucket) bucket.push(i);
    else byRoot.set(root, [i]);
  }

  // Emit clusters of size >= 2, ordered by their (smallest) root index.
  const roots = Array.from(byRoot.keys()).sort((a, b) => a - b);
  const clusters: DuplicateCluster[] = [];
  for (const root of roots) {
    const idxs = byRoot.get(root)!;
    if (idxs.length < 2) continue;
    clusters.push({
      keys: idxs.map((i) => open[i].issueKey),
      sampleSummary: open[idxs[0]].issue.summary,
    });
  }
  return clusters;
}

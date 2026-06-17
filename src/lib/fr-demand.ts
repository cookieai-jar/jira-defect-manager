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

export const UNCATEGORIZED = "Uncategorized";

/** A theme buckets >40% of open FRs — too broad to inform a decision. */
export const TOO_GENERIC_SHARE = 0.4;

export interface ThemeCluster {
  theme: string;
  count: number;
  avgDemand: number; // mean temperatureScore, 1dp
  avgValue: number; // mean severityScore, 1dp
  share: number; // count / openTotal, 0-1
  tooGeneric: boolean; // share > TOO_GENERIC_SHARE — a catch-all bucket
  keys: string[];
}

export interface ThemeClusters {
  themes: ThemeCluster[];
  openTotal: number;
  /** How many open FRs carried no component/label tag at all. */
  uncategorizedCount: number;
}

/**
 * Derive the set of theme tags a row carries: the union of ALL components and
 * ALL labels, trimmed and de-duped within the row. A row with no components and
 * no labels gets the single tag "Uncategorized". A row contributes to EVERY tag
 * it carries, so a multi-tagged row appears under multiple themes.
 */
export function themeTags(row: DemandRow): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of [...(row.issue.components ?? []), ...(row.issue.labels ?? [])]) {
    const tag = raw?.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags.length > 0 ? tags : [UNCATEGORIZED];
}

/**
 * Multi-tag theme clustering over open rows: each open row contributes to every
 * theme tag in its union of components + labels (or "Uncategorized" if it has
 * none). Because a row can carry several tags, theme counts sum to >= the open
 * total — that is expected. Each theme reports its share of the open total and
 * a `tooGeneric` flag when that share exceeds TOO_GENERIC_SHARE, so the UI can
 * de-emphasize catch-all buckets. Sorted by count desc, then avgDemand desc.
 */
export function themeClusters(rows: DemandRow[]): ThemeClusters {
  const open = openRows(rows);
  const openTotal = open.length;
  const groups = new Map<string, DemandRow[]>();
  let uncategorizedCount = 0;

  // Preserve first-seen insertion order for stable downstream tie-breaks.
  for (const r of open) {
    const tags = themeTags(r);
    if (tags.length === 1 && tags[0] === UNCATEGORIZED) uncategorizedCount++;
    for (const tag of tags) {
      const bucket = groups.get(tag);
      if (bucket) bucket.push(r);
      else groups.set(tag, [r]);
    }
  }

  const themes: ThemeCluster[] = [];
  for (const [theme, members] of groups) {
    const count = members.length;
    const share = openTotal === 0 ? 0 : count / openTotal;
    themes.push({
      theme,
      count,
      avgDemand: round1(mean(members.map((m) => m.temperatureScore))),
      avgValue: round1(mean(members.map((m) => m.severityScore))),
      share,
      tooGeneric: share > TOO_GENERIC_SHARE,
      keys: members.map((m) => m.issueKey),
    });
  }

  themes.sort((a, b) => b.count - a.count || b.avgDemand - a.avgDemand);
  return { themes, openTotal, uncategorizedCount };
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
  coveragePct: number; // triaged (= assigned) / total * 100 rounded; 0 when total is 0
}

/**
 * Triage coverage tracks real HUMAN ownership: an open FR is "untriaged" when
 * it has no assignee. An AI-assigned suggestedSprint is not a human triage act,
 * so it does not count — coverage measures who has picked the work up.
 */
export function triageCoverage(rows: DemandRow[]): TriageCoverage {
  const open = openRows(rows);
  const untriagedRows = open.filter((r) => !r.issue.assignee);
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

import type { JiraIssue, TicketAnalysis } from "@/types/triage";

/** A triage analysis joined with its source JIRA issue. */
export type Row = TicketAnalysis & { issue: JiraIssue };

export type Quadrant =
  | "build-now"
  | "strategic-bet"
  | "nice-to-have"
  | "deprioritize";

/** Human-friendly labels for each quadrant, used by the matrix UI. */
export const QUADRANT_LABELS: Record<Quadrant, string> = {
  "build-now": "Build now",
  "strategic-bet": "Strategic bet",
  "nice-to-have": "Nice to have",
  deprioritize: "Deprioritize",
};

/** Fixed iteration order: top row (high demand) first, low value → high value. */
export const QUADRANT_ORDER: readonly Quadrant[] = [
  "nice-to-have", // high demand, low value
  "build-now", // high demand, high value
  "deprioritize", // low demand, low value
  "strategic-bet", // low demand, high value
] as const;

/**
 * Fraction of the open cohort that counts as "high" on each axis. With the
 * top-40% split this guarantees a usable spread regardless of score clustering:
 * build-now ~16%, nice-to-have / strategic-bet ~24% each, deprioritize ~36%.
 */
export const HIGH_FRACTION = 0.4;

/** Classification context for a single open cohort: which keys are high on each axis. */
export interface CohortCuts {
  /** issueKeys that are in the top 40% by temperatureScore (demand). */
  highDemand: Set<string>;
  /** issueKeys that are in the top 40% by severityScore (value). */
  highValue: Set<string>;
  /** Lowest temperatureScore still counted as high demand, or null when empty. */
  demandCut: number | null;
  /** Lowest severityScore still counted as high value, or null when empty. */
  valueCut: number | null;
}

/**
 * Compute the top-40% "high" set for one axis across an open cohort.
 * Rows are sorted by score DESC, tie-broken by issueKey ASC; the first
 * `Math.ceil(0.4 * N)` rows are "high". Returns the selected keys plus the
 * `cut` = lowest score still counted as high (null when the cohort is empty).
 */
function topFractionSet(
  rows: Row[],
  score: (row: Row) => number,
): { keys: Set<string>; cut: number | null } {
  const keys = new Set<string>();
  if (rows.length === 0) return { keys, cut: null };

  const sorted = [...rows].sort((a, b) => {
    const diff = score(b) - score(a);
    if (diff !== 0) return diff;
    return a.issueKey.localeCompare(b.issueKey);
  });

  const highCount = Math.ceil(HIGH_FRACTION * rows.length);
  let cut: number | null = null;
  for (let i = 0; i < highCount; i++) {
    keys.add(sorted[i].issueKey);
    cut = score(sorted[i]);
  }
  return { keys, cut };
}

/**
 * Derive the rank-based cohort cuts from a set of open (non-resolved) rows.
 * A row is high-demand if its temperatureScore lands in the top 40% of the
 * cohort, high-value if its severityScore lands in the top 40%.
 */
export function cohortCuts(openRows: Row[]): CohortCuts {
  const demand = topFractionSet(openRows, (r) => r.temperatureScore);
  const value = topFractionSet(openRows, (r) => r.severityScore);
  return {
    highDemand: demand.keys,
    highValue: value.keys,
    demandCut: demand.cut,
    valueCut: value.cut,
  };
}

/**
 * Map a row onto one of the four Demand × Value quadrants, relative to its
 * cohort. Classification is cohort-relative (top 40% per axis), so the cuts
 * must be precomputed via {@link cohortCuts}.
 */
export function classifyQuadrant(row: Row, cuts: CohortCuts): Quadrant {
  const highDemand = cuts.highDemand.has(row.issueKey);
  const highValue = cuts.highValue.has(row.issueKey);
  if (highDemand && highValue) return "build-now";
  if (!highDemand && highValue) return "strategic-bet";
  if (highDemand && !highValue) return "nice-to-have";
  return "deprioritize";
}

export interface QuadrantCell {
  quadrant: Quadrant;
  label: string;
  rows: Row[];
}

export interface Matrix {
  cells: Record<Quadrant, QuadrantCell>;
  total: number;
  /** Lowest temperatureScore still counted as high demand, or null when empty. */
  demandCut: number | null;
  /** Lowest severityScore still counted as high value, or null when empty. */
  valueCut: number | null;
}

/** Combined demand + value score, used to rank rows within a quadrant. */
function combinedScore(row: Row): number {
  return row.temperatureScore + row.severityScore;
}

/**
 * Build the 2×2 Demand × Value matrix. Resolved rows are excluded, then each
 * axis is split at its top 40% within the remaining open cohort so the spread
 * stays usable regardless of how scores cluster. Each cell's rows are sorted by
 * combined (temperatureScore + severityScore) descending. The lowest "high"
 * score on each axis is returned as `demandCut` / `valueCut` for the UI.
 */
export function buildMatrix(rows: Row[]): Matrix {
  const cells = {} as Record<Quadrant, QuadrantCell>;
  for (const quadrant of QUADRANT_ORDER) {
    cells[quadrant] = {
      quadrant,
      label: QUADRANT_LABELS[quadrant],
      rows: [],
    };
  }

  const openRows = rows.filter((row) => row.status !== "resolved");
  const cuts = cohortCuts(openRows);

  for (const row of openRows) {
    cells[classifyQuadrant(row, cuts)].rows.push(row);
  }

  for (const quadrant of QUADRANT_ORDER) {
    cells[quadrant].rows.sort((a, b) => combinedScore(b) - combinedScore(a));
  }

  return {
    cells,
    total: openRows.length,
    demandCut: cuts.demandCut,
    valueCut: cuts.valueCut,
  };
}

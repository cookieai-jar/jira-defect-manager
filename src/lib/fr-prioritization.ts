import type { JiraIssue, TicketAnalysis } from "@/types/triage";

/** A triage analysis joined with its source JIRA issue. */
export type Row = TicketAnalysis & { issue: JiraIssue };

/** Demand / value thresholds shared with the rest of the FR PM dashboard. */
export const DEMAND_HIGH_THRESHOLD = 7;
export const VALUE_HIGH_THRESHOLD = 7;

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

export function isHighDemand(row: Row): boolean {
  return row.temperatureScore >= DEMAND_HIGH_THRESHOLD;
}

export function isHighValue(row: Row): boolean {
  return row.severityScore >= VALUE_HIGH_THRESHOLD;
}

/**
 * Map a row onto one of the four Demand × Value quadrants.
 * Demand = temperatureScore, Value = severityScore; "high" = >= 7 on each axis.
 */
export function classifyQuadrant(row: Row): Quadrant {
  const highDemand = isHighDemand(row);
  const highValue = isHighValue(row);
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
}

/** Combined demand + value score, used to rank rows within a quadrant. */
function combinedScore(row: Row): number {
  return row.temperatureScore + row.severityScore;
}

/**
 * Build the 2×2 Demand × Value matrix. Resolved rows are excluded. Each cell's
 * rows are sorted by combined (temperatureScore + severityScore) descending.
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

  let total = 0;
  for (const row of rows) {
    if (row.status === "resolved") continue;
    cells[classifyQuadrant(row)].rows.push(row);
    total += 1;
  }

  for (const quadrant of QUADRANT_ORDER) {
    cells[quadrant].rows.sort((a, b) => combinedScore(b) - combinedScore(a));
  }

  return { cells, total };
}

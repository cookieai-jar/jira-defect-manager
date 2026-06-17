import type { JiraIssue, TicketAnalysis, TrendBucket } from "@/types/triage";

/** A triage analysis row joined with its source JIRA issue. */
export type Row = TicketAnalysis & { issue: JiraIssue };

/** PM/EM decision an FR row needs. */
export type FrAction =
  | "promote"
  | "needs-spec"
  | "unblock"
  | "decline"
  | "schedule"
  | "review";

export interface FlowSummary {
  totalCreated: number;
  totalResolved: number;
  /** created - resolved over the trend window. */
  net: number;
  verdict: "growing" | "shrinking" | "steady";
  /** Count of in-flight rows (status active|blocked). */
  wip: number;
  /** True when a non-empty trend was provided. */
  hasTrend: boolean;
}

export interface DecisionItem {
  issueKey: string;
  summary: string;
  action: FrAction;
  /** demand = temperatureScore. */
  demand: number;
  /** value = severityScore. */
  value: number;
  nextStep: string;
  rationale: string;
}

/** "in-flight" = actively being worked or blocked mid-flight. */
function isInFlight(row: Row): boolean {
  return row.status === "active" || row.status === "blocked";
}

function isResolved(row: Row): boolean {
  return row.status === "resolved";
}

/**
 * Roll up trend buckets into created/resolved totals and a net-flow verdict,
 * plus the current WIP count. Undefined/empty trend yields zeros and
 * hasTrend=false (WIP is still derived from rows).
 */
export function flowSummary(
  trend: TrendBucket[] | undefined,
  rows: Row[],
): FlowSummary {
  const buckets = trend ?? [];
  const totalCreated = buckets.reduce((n, b) => n + b.created, 0);
  const totalResolved = buckets.reduce((n, b) => n + b.resolved, 0);
  const net = totalCreated - totalResolved;
  const verdict: FlowSummary["verdict"] =
    net > 0 ? "growing" : net < 0 ? "shrinking" : "steady";
  const wip = rows.filter(isInFlight).length;
  return {
    totalCreated,
    totalResolved,
    net,
    verdict,
    wip,
    hasTrend: buckets.length > 0,
  };
}

/**
 * Map a triage recommendation to the PM/EM action it implies. Blocked rows are
 * handled separately by decisionsNeeded (they become "unblock").
 */
export function mapRecommendationToAction(
  rec: TicketAnalysis["recommendation"],
): FrAction {
  switch (rec) {
    case "escalate":
      return "promote";
    case "schedule":
      return "schedule";
    case "close":
      return "decline";
    case "ping-reporter":
    case "ping-assignee":
      return "needs-spec";
    case "continue":
      return "review";
    default:
      // recommendation comes from LLM-generated JSON and is not runtime-enforced;
      // any out-of-union value degrades safely to a generic "review".
      return "review";
  }
}

const BOOSTED_RECS = new Set<TicketAnalysis["recommendation"]>([
  "escalate",
  "close",
  "schedule",
]);

/**
 * Rank open rows that need a PM/EM decision. Score = demand + value, boosted by
 * +5 for actionable recommendations (escalate/close/schedule) and +3 for blocked
 * rows (which also override the action to "unblock"). Resolved rows are excluded.
 * Returns the top `limit`, sorted by score desc then issueKey asc for stable ties.
 */
export function decisionsNeeded(rows: Row[], limit = 8): DecisionItem[] {
  const scored = rows
    .filter((r) => !isResolved(r))
    .map((r) => {
      const blocked = r.status === "blocked";
      const action: FrAction = blocked
        ? "unblock"
        : mapRecommendationToAction(r.recommendation);
      let score = r.temperatureScore + r.severityScore;
      if (BOOSTED_RECS.has(r.recommendation)) score += 5;
      if (blocked) score += 3;
      return {
        score,
        item: {
          issueKey: r.issueKey,
          summary: r.issue.summary,
          action,
          demand: r.temperatureScore,
          value: r.severityScore,
          nextStep: r.nextStep,
          rationale: r.rationale,
        } satisfies DecisionItem,
      };
    });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.item.issueKey.localeCompare(b.item.issueKey);
  });

  return scored.slice(0, limit).map((s) => s.item);
}

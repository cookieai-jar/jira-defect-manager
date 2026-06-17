import { daysSince } from "@/lib/utils";
import type { JiraIssue, TicketAnalysis } from "@/types/triage";

/** A ticket analysis joined with its source JIRA issue. */
export type DeliveryRow = TicketAnalysis & { issue: JiraIssue };

/** A ticket is "open" when it is not yet resolved. */
export function isOpen(row: DeliveryRow): boolean {
  return row.status !== "resolved";
}

/** "In-flight" = actively being worked or blocked (not backlog, not done). */
export function isInFlight(row: DeliveryRow): boolean {
  return row.status === "active" || row.status === "blocked";
}

/** Combined demand + value weight, used to rank rows within a bucket. */
function priorityWeight(row: DeliveryRow): number {
  return row.temperatureScore + row.severityScore;
}

export type SprintBucketKey = "sprint-1" | "sprint-2" | "backlog";

export interface SprintBucket {
  key: SprintBucketKey;
  label: string;
  rows: DeliveryRow[];
  count: number;
}

/**
 * Group OPEN rows into Sprint 1 / Sprint 2 / Backlog by `suggestedSprint`
 * (null => backlog). Buckets are returned in fixed order; rows inside each
 * bucket are sorted by combined demand+value weight, descending.
 */
export function sprintPlan(rows: DeliveryRow[]): SprintBucket[] {
  const open = rows.filter(isOpen);
  const buckets: { key: SprintBucketKey; label: string; match: (r: DeliveryRow) => boolean }[] = [
    { key: "sprint-1", label: "Sprint 1", match: (r) => r.suggestedSprint === 1 },
    { key: "sprint-2", label: "Sprint 2", match: (r) => r.suggestedSprint === 2 },
    { key: "backlog", label: "Backlog", match: (r) => r.suggestedSprint == null },
  ];
  return buckets.map(({ key, label, match }) => {
    const bucketRows = open
      .filter(match)
      .sort((a, b) => priorityWeight(b) - priorityWeight(a));
    return { key, label, rows: bucketRows, count: bucketRows.length };
  });
}

export interface UnstructuredFrs {
  rows: DeliveryRow[];
  count: number;
}

/**
 * Open rows with no roadmap structure at all — neither a parent issue nor any
 * component. These are truly floating asks a PM should file under an initiative.
 *
 * NOTE: an earlier version flagged any FR lacking an *Epic* parent, but on real
 * data that was ~100% of the backlog (these FRs simply aren't parented to epics),
 * making the signal useless. Requiring "no parent AND no component" isolates the
 * genuinely unfiled minority. Ranked by demand+value, descending.
 */
export function noRoadmapLink(rows: DeliveryRow[]): UnstructuredFrs {
  const unstructured = rows
    .filter(isOpen)
    .filter((r) => r.issue.parent == null && r.issue.components.length === 0)
    .sort((a, b) => priorityWeight(b) - priorityWeight(a));
  return { rows: unstructured, count: unstructured.length };
}

export interface AgingRow {
  row: DeliveryRow;
  /** Whole days since the underlying issue was last updated. */
  daysQuiet: number;
}

/**
 * In-flight (active|blocked) rows that have gone quiet for at least
 * `thresholdDays` (inclusive). This reframes "stalled": only in-flight work
 * going silent is a real signal — idle backlog is expected. The default is 30
 * days, not 14: FR work moves on product cadences, so a 14-day floor flagged
 * ~92% of in-flight items (no signal). Sorted by staleness, descending.
 */
export function inFlightAging(rows: DeliveryRow[], thresholdDays = 30): AgingRow[] {
  return rows
    .filter(isOpen)
    .filter(isInFlight)
    .map((row) => ({ row, daysQuiet: daysSince(row.issue.updated) }))
    .filter((a) => a.daysQuiet >= thresholdDays)
    .sort((a, b) => b.daysQuiet - a.daysQuiet);
}

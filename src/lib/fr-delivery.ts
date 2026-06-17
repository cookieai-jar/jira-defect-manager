import { daysSince } from "@/lib/utils";
import { hasEpicParent } from "@/types/triage";
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

export interface EpicOrphans {
  rows: DeliveryRow[];
  count: number;
}

/**
 * Open rows that are not attached to an Epic parent — i.e. unplanned FRs that
 * still need to be slotted into an epic. Ranked by demand+value, descending.
 */
export function epicOrphans(rows: DeliveryRow[]): EpicOrphans {
  const orphans = rows
    .filter(isOpen)
    .filter((r) => !hasEpicParent(r.issue))
    .sort((a, b) => priorityWeight(b) - priorityWeight(a));
  return { rows: orphans, count: orphans.length };
}

export interface AgingRow {
  row: DeliveryRow;
  /** Whole days since the underlying issue was last updated. */
  daysQuiet: number;
}

/**
 * In-flight (active|blocked) rows that have gone quiet for at least
 * `thresholdDays` (inclusive). This reframes "stalled": only in-flight work
 * going silent is a real signal — idle backlog is expected. Sorted by
 * staleness, descending.
 */
export function inFlightAging(rows: DeliveryRow[], thresholdDays = 14): AgingRow[] {
  return rows
    .filter(isOpen)
    .filter(isInFlight)
    .map((row) => ({ row, daysQuiet: daysSince(row.issue.updated) }))
    .filter((a) => a.daysQuiet >= thresholdDays)
    .sort((a, b) => b.daysQuiet - a.daysQuiet);
}

import { daysSince } from "@/lib/utils";
import type { JiraIssue, TicketAnalysis } from "@/types/triage";

/** A ticket analysis joined to its JIRA issue. Mirrors fr-pm-table.tsx's Row. */
export type Row = TicketAnalysis & { issue: JiraIssue };

export const UNASSIGNED = "Unassigned";

/** A row is open unless its analysis status is "resolved". */
export function isOpen(row: Row): boolean {
  return row.status !== "resolved";
}

/** "in-flight" = actively being worked or blocked on a dependency. */
export function isInFlight(row: Row): boolean {
  return row.status === "active" || row.status === "blocked";
}

export interface OwnershipEntry {
  assignee: string;
  count: number;
  rows: Row[];
}

export interface OwnershipLoad {
  entries: OwnershipEntry[];
  max: number;
  total: number;
}

/**
 * Group open (non-resolved) rows by assignee. Null/empty assignee names bucket
 * into "Unassigned". Entries are sorted by count descending. `max` is the
 * largest single count (for proportional bars); `total` is the open-row count.
 */
export function ownershipLoad(rows: Row[]): OwnershipLoad {
  const open = rows.filter(isOpen);
  const byAssignee = new Map<string, Row[]>();
  for (const row of open) {
    const raw = row.issue.assignee;
    const name = raw && raw.trim() ? raw.trim() : UNASSIGNED;
    const bucket = byAssignee.get(name);
    if (bucket) bucket.push(row);
    else byAssignee.set(name, [row]);
  }

  const entries: OwnershipEntry[] = Array.from(byAssignee.entries())
    .map(([assignee, entryRows]) => ({
      assignee,
      count: entryRows.length,
      rows: entryRows,
    }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      // Among equal counts, keep "Unassigned" last and otherwise sort by name.
      if (a.assignee === UNASSIGNED) return 1;
      if (b.assignee === UNASSIGNED) return -1;
      return a.assignee.localeCompare(b.assignee);
    });

  const max = entries.reduce((m, e) => Math.max(m, e.count), 0);
  const total = open.length;
  return { entries, max, total };
}

export interface BlockedItem {
  row: Row;
  key: string;
  summary: string;
  /** nextStep → rationale → default. */
  reason: string;
  ageDays: number;
}

const NO_REASON = "No reason recorded";

/**
 * Open rows whose analysis status is "blocked", annotated with a human-readable
 * reason (nextStep → rationale → default) and ageDays (days since the issue was
 * last updated). Sorted by ageDays descending (stalest first).
 */
export function blockedItems(rows: Row[]): BlockedItem[] {
  return rows
    .filter((row) => row.status === "blocked")
    .map((row) => {
      const reason =
        (row.nextStep && row.nextStep.trim()) ||
        (row.rationale && row.rationale.trim()) ||
        NO_REASON;
      return {
        row,
        key: row.issueKey,
        summary: row.issue.summary,
        reason,
        ageDays: daysSince(row.issue.updated),
      };
    })
    .sort((a, b) => b.ageDays - a.ageDays);
}

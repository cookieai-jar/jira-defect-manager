import type { JiraIssue } from "@/types/triage";
import { computeSlaStatusAt, priorityFromString } from "./priority";

/**
 * Pure logic for the All Defects historical trends — building a day's
 * distribution snapshot from open issues, reconstructing past days from a full
 * (open + resolved) JIRA history, and pivoting stored rows into per-tile series.
 * No db/anthropic import, so it's unit-testable and client-safe.
 */

/** One (group, key, count) cell of a day's snapshot. */
export interface TrendPoint {
  grp: string;
  key: string;
  count: number;
}

/** A stored snapshot row. */
export interface SnapshotRow {
  day: string;
  grp: string;
  key: string;
  count: number;
}

export interface TrendSeries {
  key: string;
  points: number[];
}

export interface GroupTrend {
  days: string[];
  series: TrendSeries[];
}

export const PRIORITY_KEYS = ["P0", "P1", "P2", "P3", "Unset"] as const;

/** Groups reconstructable from a ticket's created/resolved dates (approx: current priority/customer/assignee). */
export const RECONSTRUCTABLE_GROUPS = ["total", "priority", "sla", "customer", "assignee"];

function prio(issue: JiraIssue): string {
  return priorityFromString(issue.priority) ?? "Unset";
}

function bump(m: Map<string, number>, k: string) {
  m.set(k, (m.get(k) ?? 0) + 1);
}

/**
 * PURE. Distribution of a set of OPEN issues into snapshot points, as of `nowMs`
 * (used for SLA age). Covers every tile group except category (LLM-derived).
 */
export function distribution(openIssues: JiraIssue[], nowMs: number): TrendPoint[] {
  const out: TrendPoint[] = [];
  out.push({ grp: "total", key: "open", count: openIssues.length });

  const byPriority = new Map<string, number>();
  const byStatus = new Map<string, number>();
  const byAssignee = new Map<string, number>();
  const byCustomer = new Map<string, number>();
  let late = 0;

  for (const i of openIssues) {
    bump(byPriority, prio(i));
    bump(byStatus, i.status);
    bump(byAssignee, i.assignee ?? "Unassigned");
    for (const c of i.customers) bump(byCustomer, c);
    if (!i.resolved && computeSlaStatusAt(priorityFromString(i.priority), i.created, nowMs) === "late") {
      late++;
    }
  }

  for (const k of PRIORITY_KEYS) if (byPriority.get(k)) out.push({ grp: "priority", key: k, count: byPriority.get(k)! });
  for (const [k, c] of byStatus) out.push({ grp: "status", key: k, count: c });
  for (const [k, c] of byAssignee) out.push({ grp: "assignee", key: k, count: c });
  for (const [k, c] of byCustomer) out.push({ grp: "customer", key: k, count: c });
  out.push({ grp: "sla", key: "late", count: late });
  return out;
}

/** True if `issue` was open at the end of `dayEndMs`. */
function openOn(issue: JiraIssue, dayEndMs: number): boolean {
  const created = Date.parse(issue.created);
  if (!(created <= dayEndMs)) return false;
  if (!issue.resolved) return true;
  return Date.parse(issue.resolved) > dayEndMs;
}

/**
 * PURE. Reconstruct the reconstructable groups for one past `day` (YYYY-MM-DD)
 * from a full history (open + resolved). Priority/customer/assignee are the
 * ticket's CURRENT values (JIRA doesn't cheaply expose them as-of-then).
 */
export function reconstructDay(historyIssues: JiraIssue[], day: string): TrendPoint[] {
  const dayEndMs = Date.parse(`${day}T23:59:59.999Z`);
  const open = historyIssues.filter((i) => openOn(i, dayEndMs));
  return distribution(open, dayEndMs).filter((p) => RECONSTRUCTABLE_GROUPS.includes(p.grp));
}

/** PURE. Inclusive list of YYYY-MM-DD day strings ending at `endMs`, `n` days long. */
export function lastNDays(endMs: number, n: number): string[] {
  const days: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    days.push(new Date(endMs - i * 86_400_000).toISOString().slice(0, 10));
  }
  return days;
}

/**
 * PURE. Pivot stored snapshot rows into per-group trends. Days are the sorted
 * union of days seen for that group; each series is aligned to those days
 * (missing day → 0). Series are ordered by their latest value, descending.
 */
export function pivotTrends(rows: SnapshotRow[]): Record<string, GroupTrend> {
  const byGrp = new Map<string, SnapshotRow[]>();
  for (const r of rows) {
    const arr = byGrp.get(r.grp) ?? [];
    arr.push(r);
    byGrp.set(r.grp, arr);
  }
  const out: Record<string, GroupTrend> = {};
  for (const [grp, grpRows] of byGrp) {
    const days = [...new Set(grpRows.map((r) => r.day))].sort();
    const dayIndex = new Map(days.map((d, i) => [d, i]));
    const byKey = new Map<string, number[]>();
    for (const r of grpRows) {
      let pts = byKey.get(r.key);
      if (!pts) {
        pts = new Array(days.length).fill(0);
        byKey.set(r.key, pts);
      }
      pts[dayIndex.get(r.day)!] = r.count;
    }
    const series = [...byKey.entries()]
      .map(([key, points]) => ({ key, points }))
      .sort((a, b) => (b.points[b.points.length - 1] ?? 0) - (a.points[a.points.length - 1] ?? 0));
    out[grp] = { days, series };
  }
  return out;
}

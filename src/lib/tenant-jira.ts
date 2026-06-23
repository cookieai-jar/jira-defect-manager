import type { TenantJiraTicket } from "@/types/tenant";

/**
 * Grouping + priority-sorting for the per-tenant JIRA tickets section.
 * Tickets are split into the EAC / OPS / FR projects (plus an "Other" catch-all),
 * sorted by priority within each, with Done tickets separated for collapsing.
 * Pure + unit-tested.
 */

/** The named project sections, in display order. */
export const TICKET_PROJECTS = ["EAC", "OPS", "FR"] as const;
export const OTHER_PROJECT = "Other";

/** Project key from an issue key: "EAC-123" -> "EAC". Uppercased; "" when malformed. */
export function ticketProject(key: string): string {
  const m = /^([A-Za-z][A-Za-z0-9]*)-\d+/.exec(key.trim());
  return m ? m[1].toUpperCase() : "";
}

/**
 * Priority sort rank (lower = more urgent). Handles both the P0–P3 scheme and
 * JIRA's Highest/High/Medium/Low/Lowest names; unknown/unset sort last.
 */
export function priorityRank(priority: string | null | undefined): number {
  if (!priority) return 99;
  const p = priority.trim().toLowerCase();
  const table: Record<string, number> = {
    p0: 0, blocker: 0, highest: 0,
    p1: 1, critical: 1, high: 1,
    p2: 2, major: 2, medium: 2,
    p3: 3, minor: 3, low: 3,
    p4: 4, trivial: 4, lowest: 4,
  };
  return p in table ? table[p] : 90;
}

/** Sort tickets by priority (urgent first), tie-broken by key for stability. */
export function sortByPriority(tickets: TenantJiraTicket[]): TenantJiraTicket[] {
  return [...tickets].sort(
    (a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.key.localeCompare(b.key),
  );
}

export interface ProjectTicketGroup {
  project: string;
  open: TenantJiraTicket[];
  done: TenantJiraTicket[];
  total: number;
}

/**
 * Group tickets into the named projects (in fixed order) plus an "Other" group
 * for anything else. Each group splits open vs done and sorts both by priority.
 * Empty named projects are still returned (so the UI can show all three);
 * "Other" is only returned when it has tickets.
 */
export function groupTicketsByProject(
  tickets: TenantJiraTicket[],
  projects: readonly string[] = TICKET_PROJECTS,
): ProjectTicketGroup[] {
  const byProject = new Map<string, TenantJiraTicket[]>();
  for (const t of tickets) {
    const proj = ticketProject(t.key);
    const bucket = projects.includes(proj) ? proj : OTHER_PROJECT;
    const list = byProject.get(bucket) ?? [];
    list.push(t);
    byProject.set(bucket, list);
  }

  const make = (project: string): ProjectTicketGroup => {
    const list = byProject.get(project) ?? [];
    return {
      project,
      open: sortByPriority(list.filter((t) => !t.done)),
      done: sortByPriority(list.filter((t) => t.done)),
      total: list.length,
    };
  };

  const groups = projects.map(make);
  if ((byProject.get(OTHER_PROJECT) ?? []).length > 0) groups.push(make(OTHER_PROJECT));
  return groups;
}

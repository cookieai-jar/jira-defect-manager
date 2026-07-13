import type { Priority, SlaStatus } from "@/types/triage";

export const PRIORITIES: readonly Priority[] = ["P0", "P1", "P2", "P3"] as const;

export interface PriorityDef {
  level: Priority;
  impact: string;
  sla: string;
  /** Days from ticket creation when investigation must have started. */
  slaInvestigationDays: number;
  /** Days from ticket creation when fix must have shipped. null = best-effort. */
  slaFixDays: number | null;
}

export const PRIORITY_DEFINITIONS: Record<Priority, PriorityDef> = {
  P0: {
    level: "P0",
    impact:
      "Veza platform or a significant product capability is unavailable. All hands on deck.",
    sla:
      "All hands on deck. Engineering begins investigating immediately and provides resolution within 24 hours.",
    slaInvestigationDays: 0,
    slaFixDays: 1,
  },
  P1: {
    level: "P1",
    impact:
      "One or multiple customers are impacted; a significant set of capabilities is not working or is severely impacted. There is no workaround.",
    sla:
      "Investigation begins within the current sprint; the fix can be scheduled to the next sprint (≈4 weeks).",
    slaInvestigationDays: 14,
    slaFixDays: 28,
  },
  P2: {
    level: "P2",
    impact: "Customer-visible issue that has a viable workaround.",
    sla:
      "Investigation begins in the next sprint; the fix can be scheduled within a quarter (≈12 weeks).",
    slaInvestigationDays: 28,
    slaFixDays: 84,
  },
  P3: {
    level: "P3",
    impact:
      "Aesthetic issues; core product functionality not impacted; a visible workaround or an alternative capability exists.",
    sla:
      "Investigation begins within 2 months. No commitment — best effort.",
    slaInvestigationDays: 60,
    slaFixDays: null,
  },
};

const PRIORITY_ALIASES: Record<string, Priority> = {
  P0: "P0",
  P1: "P1",
  P2: "P2",
  P3: "P3",
  HIGHEST: "P0",
  CRITICAL: "P0",
  BLOCKER: "P0",
  HIGH: "P1",
  MAJOR: "P1",
  MEDIUM: "P2",
  NORMAL: "P2",
  LOW: "P3",
  MINOR: "P3",
  TRIVIAL: "P3",
};

export function priorityFromString(p: string | null | undefined): Priority | null {
  if (!p) return null;
  const norm = p.toUpperCase().trim();
  return PRIORITY_ALIASES[norm] ?? null;
}

/**
 * Days from ticket creation that should trigger the worst-case SLA milestone:
 *  - For P0/P1/P2: the fix-deadline window.
 *  - For P3: the investigation-start window (no fix commitment).
 */
function slaTargetDays(priority: Priority): number {
  const def = PRIORITY_DEFINITIONS[priority];
  return def.slaFixDays ?? def.slaInvestigationDays;
}

export function slaTargetDate(priority: Priority | null, createdIso: string): string | null {
  if (!priority || !createdIso) return null;
  const created = new Date(createdIso);
  if (isNaN(created.getTime())) return null;
  const days = slaTargetDays(priority);
  const target = new Date(created);
  target.setUTCDate(target.getUTCDate() + days);
  return target.toISOString();
}

export function computeSlaStatus(
  priority: Priority | null,
  createdIso: string,
): SlaStatus {
  return computeSlaStatusAt(priority, createdIso, Date.now());
}

/** Like {@link computeSlaStatus} but evaluated as of an explicit time (for historical reconstruction). */
export function computeSlaStatusAt(
  priority: Priority | null,
  createdIso: string,
  nowMs: number,
): SlaStatus {
  if (!priority) return "best-effort";
  const created = new Date(createdIso);
  if (isNaN(created.getTime())) return "best-effort";
  const ageDays = (nowMs - created.getTime()) / (1000 * 60 * 60 * 24);
  const target = slaTargetDays(priority);
  if (priority === "P3" && PRIORITY_DEFINITIONS.P3.slaFixDays == null) {
    // P3 has no fix commitment. Late = investigation hasn't started in time.
    if (ageDays >= target) return "best-effort"; // past the investigation window, but no hard commitment
    return "on-track";
  }
  if (ageDays >= target) return "late";
  if (ageDays >= target * 0.8) return "at-risk";
  return "on-track";
}

export function priorityChangeFor(
  current: Priority | null,
  recommended: Priority | null,
): "raise" | "lower" | "keep" | null {
  if (!current || !recommended) return null;
  if (current === recommended) return "keep";
  const order: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
  return order[recommended] < order[current] ? "raise" : "lower";
}

import type { JiraIssue, Scope, TriageReport } from "@/types/triage";
import { computeSlaStatus, priorityFromString } from "./priority";

/**
 * Pure aggregation for the Overview page — folds each scope's latest report +
 * issues into per-dashboard summaries and a single prioritized action queue for
 * the engineering manager. No db/anthropic import, so it's unit-testable and the
 * types are safe to import from the client.
 */

export type ActionKind = "escalate" | "sla" | "ping" | "close";

export interface ActionItem {
  issueKey: string;
  summary: string;
  scope: Scope;
  scopeLabel: string;
  /** Dashboard path for drill-in. */
  href: string;
  /** Direct JIRA link for taking action. */
  url: string;
  kind: ActionKind;
  priority: string | null;
  customer: string | null;
  assignee: string | null;
  /** What the EM should do (from the ticket analysis, or a default per kind). */
  nextStep: string;
  isP0Customer: boolean;
  daysSinceUpdate: number;
  /** Sort weight; higher = more urgent. */
  rank: number;
}

export interface ScopeSummary {
  scope: Scope;
  label: string;
  href: string;
  synced: boolean;
  open: number;
  escalations: number;
  pastSla: number;
  needPing: number;
  closeCandidates: number;
  /** White-glove customers in a red state; null for scopes without white-glove. */
  redCustomers: number | null;
}

export interface Overview {
  generatedAt: string;
  scopes: ScopeSummary[];
  actions: ActionItem[];
  totals: {
    open: number;
    actions: number;
    escalations: number;
    pastSla: number;
    needPing: number;
    closeCandidates: number;
  };
  /** Prevention picture from the Product Defect Analysis; null until it has run. */
  pda?: PdaAttention | null;
}

/** One metric currently moving the wrong way, ready to render without joins. */
export interface PdaWrongWayMetric {
  key: string;
  name: string;
  unit: string;
  baseline: number;
  current: number;
  /** Relative move as a signed percentage of baseline (display-ready). */
  movePct: number;
}

/**
 * The Product Defect Analysis distilled to what belongs on the landing page:
 * metrics degrading vs baseline and the funded-next prevention actions. The
 * triage queue above it says "work these tickets"; this says "fix the system
 * that produces them" — both are EM actions, so they live on one screen.
 */
export interface PdaAttention {
  generatedAt: string;
  href: string;
  totalDefects: number;
  wrongWay: PdaWrongWayMetric[];
  nowStrategies: Array<{ key: string; title: string; team: string; discipline: string }>;
}

interface PdaMetricLike {
  key: string;
  name: string;
  unit: string;
  direction: "down-good" | "up-good";
  automated: boolean;
  current: number | null;
  baseline: number | null;
}
interface PdaStrategyLike {
  key: string;
  title: string;
  team: string;
  discipline: string;
  priority: string;
}

/** PURE. Distill a PDA report into the landing-page attention block. */
export function buildPdaAttention(report: {
  generatedAt: string;
  analyzedTickets: number;
  metrics: PdaMetricLike[];
  strategies: PdaStrategyLike[];
}): PdaAttention {
  const wrongWay: PdaWrongWayMetric[] = [];
  for (const m of report.metrics) {
    if (!m.automated || m.current == null || m.baseline == null || m.baseline === 0) continue;
    const d = m.current - m.baseline;
    const worse = m.direction === "down-good" ? d > 0 : d < 0;
    const movePct = Math.round((d / Math.abs(m.baseline)) * 1000) / 10;
    // Sub-2% relative moves are noise at this population size, not a trend.
    if (!worse || Math.abs(movePct) < 2) continue;
    wrongWay.push({ key: m.key, name: m.name, unit: m.unit, baseline: m.baseline, current: m.current, movePct });
  }
  wrongWay.sort((a, b) => Math.abs(b.movePct) - Math.abs(a.movePct));

  return {
    generatedAt: report.generatedAt,
    href: "/product-defects",
    totalDefects: report.analyzedTickets,
    wrongWay: wrongWay.slice(0, 4),
    nowStrategies: report.strategies
      .filter((s) => s.priority === "now")
      .slice(0, 5)
      .map((s) => ({ key: s.key, title: s.title, team: s.team, discipline: s.discipline })),
  };
}

export interface ScopeInput {
  scope: Scope;
  label: string;
  href: string;
  hasP0: boolean;
  /** Whether SLA-from-creation applies (false for feature requests, which aren't defects). */
  slaApplies: boolean;
  jiraBaseUrl: string;
  report: TriageReport | null;
  issues: JiraIssue[];
}

const KIND_WEIGHT: Record<ActionKind, number> = {
  escalate: 400,
  sla: 300,
  ping: 200,
  close: 100,
};

function priorityWeight(priority: string | null): number {
  const p = priorityFromString(priority);
  return p === "P0" ? 80 : p === "P1" ? 60 : p === "P2" ? 40 : p === "P3" ? 20 : 0;
}

function defaultNextStep(kind: ActionKind, target?: "reporter" | "assignee"): string {
  switch (kind) {
    case "escalate":
      return "Escalate — needs a decision or more hands.";
    case "sla":
      return "Past SLA — expedite or re-prioritize.";
    case "ping":
      return target === "reporter"
        ? "Ping the reporter for missing info."
        : "Ping the assignee for a status update.";
    case "close":
      return "Review and close if resolved.";
  }
}

/** PURE. Build the overview across all supplied scopes at time `now`. */
export function buildOverview(inputs: ScopeInput[], now: string): Overview {
  const scopes: ScopeSummary[] = [];
  const actions: ActionItem[] = [];

  for (const input of inputs) {
    const issueMap = new Map(input.issues.map((i) => [i.key, i]));
    const doneKeys = new Set(
      input.issues.filter((i) => i.statusCategory === "done").map((i) => i.key),
    );
    const report = input.report;
    const analyses = report
      ? report.ticketAnalyses.filter((a) => !doneKeys.has(a.issueKey))
      : [];

    const pingByKey = new Map(
      (report?.pingCandidates ?? [])
        .filter((p) => !doneKeys.has(p.issueKey))
        .map((p) => [p.issueKey, p.target]),
    );
    const closeSet = new Set(
      (report?.closeCandidates ?? []).filter((k) => !doneKeys.has(k)),
    );

    const isLate = (key: string): boolean => {
      if (!input.slaApplies) return false;
      const issue = issueMap.get(key);
      if (!issue) return false;
      return computeSlaStatus(priorityFromString(issue.priority), issue.created) === "late";
    };

    let escalations = 0;
    let pastSla = 0;

    for (const a of analyses) {
      const issue = issueMap.get(a.issueKey);
      if (!issue) continue;
      const late = isLate(a.issueKey);
      if (late) pastSla++;
      if (a.recommendation === "escalate") escalations++;

      // One action per ticket — its single most urgent next step.
      const pingTarget = pingByKey.get(a.issueKey);
      const kind: ActionKind | null =
        a.recommendation === "escalate"
          ? "escalate"
          : late
            ? "sla"
            : pingTarget
              ? "ping"
              : closeSet.has(a.issueKey)
                ? "close"
                : null;
      if (!kind) continue;

      actions.push({
        issueKey: a.issueKey,
        summary: issue.summary,
        scope: input.scope,
        scopeLabel: input.label,
        href: input.href,
        url: issue.url || `${input.jiraBaseUrl}/browse/${a.issueKey}`,
        kind,
        priority: issue.priority,
        customer: a.customer ?? (issue.customers[0] ?? null),
        assignee: issue.assignee,
        nextStep: a.nextStep?.trim() || defaultNextStep(kind, pingTarget),
        isP0Customer: a.isP0Customer,
        daysSinceUpdate: a.daysSinceUpdate,
        rank:
          KIND_WEIGHT[kind] + (a.isP0Customer ? 150 : 0) + priorityWeight(issue.priority),
      });
    }

    scopes.push({
      scope: input.scope,
      label: input.label,
      href: input.href,
      synced: report != null,
      open: analyses.length,
      escalations,
      pastSla,
      needPing: pingByKey.size,
      closeCandidates: closeSet.size,
      redCustomers: input.hasP0
        ? (report?.p0Summaries ?? []).filter((s) => s.health === "red").length
        : null,
    });
  }

  actions.sort((a, b) => b.rank - a.rank || b.daysSinceUpdate - a.daysSinceUpdate);

  return {
    generatedAt: now,
    scopes,
    actions,
    totals: {
      open: scopes.reduce((n, s) => n + s.open, 0),
      actions: actions.length,
      escalations: scopes.reduce((n, s) => n + s.escalations, 0),
      pastSla: scopes.reduce((n, s) => n + s.pastSla, 0),
      needPing: scopes.reduce((n, s) => n + s.needPing, 0),
      closeCandidates: scopes.reduce((n, s) => n + s.closeCandidates, 0),
    },
  };
}

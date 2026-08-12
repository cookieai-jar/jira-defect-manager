export type TemperatureBand = "cold" | "cool" | "warm" | "hot" | "critical";

export type Priority = "P0" | "P1" | "P2" | "P3";
export type SlaStatus = "on-track" | "at-risk" | "late" | "best-effort";
export type PriorityChange = "raise" | "lower" | "keep";

export interface PriorityDecision {
  issueKey: string;
  decision: "ignore";
  decidedAt: string;
  /** Snapshot at the time of the decision — used to detect drift on the next sync. */
  decidedPriorityChange: PriorityChange | null;
  decidedRecommendedPriority: Priority | null;
  decidedCurrentPriority: Priority | null;
  /** JIRA issue.updated when the user made the decision. */
  decidedTicketUpdatedAt: string | null;
  revisitFlagged: boolean;
  revisitReason: string | null;
}

export type Scope =
  | "eac"
  | "fr"
  | "sec"
  | "alerts"
  | "incidents"
  | "alldefects"
  | "ops"
  | "automation";

export const SCOPES: readonly Scope[] = [
  "eac",
  "fr",
  "sec",
  "alerts",
  "incidents",
  "alldefects",
  "ops",
  "automation",
] as const;

export const SCOPE_LABELS: Record<Scope, string> = {
  eac: "Customer",
  fr: "FR",
  sec: "Security",
  alerts: "Alerts",
  incidents: "Incidents",
  alldefects: "All Defects",
  ops: "OPS",
  automation: "Automation",
};

/** Scopes that have a P0 customer correlation section on their dashboard. */
export const SCOPES_WITH_P0: readonly Scope[] = ["eac", "fr"] as const;

export function isScope(s: string | null | undefined): s is Scope {
  return (
    s === "eac" ||
    s === "fr" ||
    s === "sec" ||
    s === "alerts" ||
    s === "incidents" ||
    s === "alldefects" ||
    s === "ops" ||
    s === "automation"
  );
}

export function scopeHasP0(scope: Scope): boolean {
  return SCOPES_WITH_P0.includes(scope);
}

export interface JiraComment {
  id: string;
  author: string;
  body: string;
  created: string;
  updated: string;
}

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  statusCategory: "new" | "indeterminate" | "done" | "undefined";
  priority: string | null;
  issueType: string;
  reporter: string | null;
  assignee: string | null;
  created: string;
  updated: string;
  resolved: string | null;
  labels: string[];
  components: string[];
  url: string;
  description: string | null;
  comments: JiraComment[];
  /** Parent issue (e.g. the Epic). null when the ticket has no parent. */
  parent: { key: string; summary: string; type: string } | null;
  /**
   * Values of the "Customer" multi-select field (customfield_10044), e.g.
   * ["Prudential Financial"]. This is the canonical join key to a tenant.
   * Empty array when the field is unset.
   */
  customers: string[];
  /**
   * "Targeted Month" option value (customfield_11123), e.g. "Jul '26" — the
   * month an FR is committed for. null when unset. Only FRs carry this.
   */
  targetedMonth: string | null;
}

type JiraStatusCategory = JiraIssue["statusCategory"];

/** A blocking/related issue link surfaced on an FR or its child epics. */
export interface RoadmapDependency {
  key: string;
  summary: string;
  status: string;
  statusCategory: JiraStatusCategory;
  /** Link direction relative to the source issue. */
  direction: "blocks" | "blocked-by" | "depends-on" | "relates";
  url: string;
  /** True when this is an unresolved blocker (blocked-by/depends-on and not done). */
  isBlocker: boolean;
}

/** A child EAC ticket (epic) of a committed FR. */
export interface RoadmapChild {
  key: string;
  summary: string;
  status: string;
  statusCategory: JiraStatusCategory;
  type: string;
  url: string;
  dependencies: RoadmapDependency[];
  /** Planning fields that are unset (subset of "Due Date"/"Original Estimate"/"Sprint"). */
  missingFields: string[];
  /** Assignee, for the "ping to fill fields" action; null when unassigned. */
  assignee: { accountId: string; displayName: string } | null;
  /** How many times this epic has been pinged (from our ping log). */
  pingCount: number;
  /** ISO timestamp of the last ping, or null if never pinged. */
  lastPingedAt: string | null;
}

/** One committed FR within a target month, with its child epics + dependencies. */
export interface RoadmapFr {
  key: string;
  summary: string;
  status: string;
  statusCategory: JiraStatusCategory;
  targetedMonth: string;
  url: string;
  children: RoadmapChild[];
  dependencies: RoadmapDependency[];
  /** Count of unresolved blockers across the FR + its children (drives highlight). */
  blockerCount: number;
  /** Child epics with ≥1 missing planning field. */
  incompleteChildCount: number;
}

/** All FRs committed for one target month (the month's "payload"). */
export interface CommittedMonth {
  /** Sortable key, e.g. "2026-07". */
  key: string;
  /** Display label, e.g. "Jul '26". */
  label: string;
  /** Whether the month is before the current month. */
  isPast: boolean;
  frs: RoadmapFr[];
  /** Payload counts for the month. */
  frCount: number;
  childCount: number;
  blockerCount: number;
  /** Child epics (across the month's FRs) with ≥1 missing planning field. */
  incompleteChildCount: number;
}

/** The committed roadmap grouped by target month (chronological). */
export interface CommittedRoadmap {
  months: CommittedMonth[];
  /** FRs whose Targeted Month is set but couldn't be parsed (surfaced, not silently dropped). */
  dropped: { key: string; rawValue: string }[];
  generatedAt: string;
}

/** True when the issue's parent is an Epic. Used to flag tickets that still need an epic assigned. */
export function hasEpicParent(issue: Pick<JiraIssue, "parent">): boolean {
  return issue.parent?.type?.toLowerCase() === "epic";
}

export interface P0Customer {
  id: string;
  name: string;
  jqlFragment: string;
  notes: string | null;
  createdAt: string;
  lastAnalyzedAt: string | null;
}

export interface AppConfig {
  jqls: Record<Scope, string>;
  dashboards: Record<Scope, boolean>;
  /** JQL defining the universe of Strategic Integrations tickets to analyze. */
  siJql: string;
  /** Whether the Strategic Integrations dashboard is shown in the sidebar. */
  siDashboard: boolean;
  /** Whether the per-tenant Integrations Health dashboard is shown in the sidebar. */
  tenantDashboard: boolean;
  /** JQL defining the universe of customer-found defects to analyze. */
  pdaJql: string;
  /** Whether the Product Defect Analysis dashboard is shown in the sidebar. */
  pdaDashboard: boolean;
  /** Absolute path to the product source repo that defects are correlated against. */
  codeRepoPath: string;
  /**
   * Minimum defects a JIRA component needs before it gets its own Product
   * Defect Analysis page. Below this there isn't enough evidence for a pattern,
   * and a thin narrative reads as speculation.
   */
  pdaComponentMinDefects: number;
  sprintLengthDays: number;
  inactivityThresholdDays: number;
  pingThresholdDays: number;
  model: string;
  maxIssuesPerSync: number;
}

export interface TicketAnalysis {
  issueKey: string;
  severityScore: number;        // 1-10
  temperature: TemperatureBand;
  temperatureScore: number;      // 1-10
  customer: string | null;       // best-effort customer name from labels/title/comments
  isP0Customer: boolean;
  status: "active" | "stalled" | "blocked" | "ready-to-close" | "resolved";
  daysSinceUpdate: number;
  recommendation: "close" | "ping-reporter" | "ping-assignee" | "escalate" | "continue" | "schedule";
  rationale: string;
  nextStep: string;
  suggestedSprint: 1 | 2 | null; // null = backlog / longer than 2 sprints
  evidenceQuotes: string[];      // short quotes pulled from comments backing the temperature read
  // EAC-only priority & SLA analysis. Other scopes leave these null.
  currentPriority?: Priority | null;
  recommendedPriority?: Priority | null;
  priorityChange?: PriorityChange | null;
  priorityRationale?: string;
  slaStatus?: SlaStatus | null;
  slaTargetDate?: string | null; // ISO date when SLA fix window closes
}

export interface ResolvedTicketRef {
  key: string;
  summary: string;
  resolved: string | null;
  assignee: string | null;
  url: string;
  priority: string | null;
  status: string | null;
}

export interface P0Summary {
  customer: string;
  weeklyProgress: string;        // markdown
  dailyTracker: string;          // markdown
  resolutionPlan: string;        // markdown
  openIssueKeys: string[];
  resolvedTickets?: ResolvedTicketRef[];
  blockers: string[];
  health: "green" | "yellow" | "red";
  generatedAt: string;
}

export interface TrendBucket {
  date: string;      // YYYY-MM-DD (UTC)
  created: number;
  resolved: number;
}

export interface TriageReport {
  generatedAt: string;
  p0Summaries: P0Summary[];
  ticketAnalyses: TicketAnalysis[];
  closeCandidates: string[];     // issue keys
  pingCandidates: { issueKey: string; target: "reporter" | "assignee" }[];
  trend?: TrendBucket[];
}

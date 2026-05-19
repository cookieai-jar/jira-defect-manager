export type TemperatureBand = "cold" | "cool" | "warm" | "hot" | "critical";

export type Scope = "eac" | "fr" | "sec";

export const SCOPES: readonly Scope[] = ["eac", "fr", "sec"] as const;

export const SCOPE_LABELS: Record<Scope, string> = {
  eac: "Customer",
  fr: "FR",
  sec: "Security",
};

/** Scopes that have a P0 customer correlation section on their dashboard. */
export const SCOPES_WITH_P0: readonly Scope[] = ["eac", "fr"] as const;

export function isScope(s: string | null | undefined): s is Scope {
  return s === "eac" || s === "fr" || s === "sec";
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
}

export interface P0Summary {
  customer: string;
  weeklyProgress: string;        // markdown
  dailyTracker: string;          // markdown
  resolutionPlan: string;        // markdown
  openIssueKeys: string[];
  blockers: string[];
  health: "green" | "yellow" | "red";
  generatedAt: string;
}

export interface TriageReport {
  generatedAt: string;
  p0Summaries: P0Summary[];
  ticketAnalyses: TicketAnalysis[];
  closeCandidates: string[];     // issue keys
  pingCandidates: { issueKey: string; target: "reporter" | "assignee" }[];
}

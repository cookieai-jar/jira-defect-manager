/**
 * Types for the Product Defect Analysis dashboard.
 *
 * A clone-and-deepen of the Strategic Integrations dashboard, pointed at the
 * full population of *customer-found* defects (EAC bugs with a non-empty
 * Customer field) over a rolling window. Where the Integrations dashboard asks
 * "which connector is failing?", this one asks:
 *
 *   1. What KINDS of defects do customers find? (groups → sub-groups)
 *   2. WHY did each kind escape us? (root cause + escape analysis)
 *   3. WHERE does it live in the code, and WHO owns it? (git + CODEOWNERS)
 *   4. WHAT do we change — process, code, quality, testing — to prevent it?
 *   5. HOW do we know it worked? (metrics, trended over time)
 *
 * Deliberately independent of `@/types/integrations`: the two dashboards share
 * shapes by coincidence, not by contract, and coupling them would make either
 * one painful to evolve.
 */

export type Effort = "low" | "medium" | "high";
export type ActionPriority = "now" | "next" | "later";

export const EFFORTS: readonly Effort[] = ["low", "medium", "high"] as const;
export const ACTION_PRIORITIES: readonly ActionPriority[] = ["now", "next", "later"] as const;

/**
 * The engineering discipline a prevention action belongs to. Drives the
 * grouping of the action plan — each discipline is a different team ritual.
 */
export type PreventionDiscipline =
  | "process"
  | "code"
  | "quality"
  | "unit-test"
  | "integration-test"
  | "e2e-test"
  | "scale-test"
  | "observability";

export const PREVENTION_DISCIPLINES: readonly PreventionDiscipline[] = [
  "process",
  "code",
  "quality",
  "unit-test",
  "integration-test",
  "e2e-test",
  "scale-test",
  "observability",
] as const;

export const DISCIPLINE_LABELS: Record<PreventionDiscipline, string> = {
  process: "Process",
  code: "Code / Architecture",
  quality: "Code Quality & Review",
  "unit-test": "Unit testing",
  "integration-test": "Integration testing",
  "e2e-test": "End-to-end testing",
  "scale-test": "Scale & performance testing",
  observability: "Observability",
};

/**
 * The earliest gate that *should* have caught the defect before a customer did.
 * This is the escape-analysis axis: a pile of defects whose stage is
 * "integration-test" is an integration-test gap, not a coding-skill problem.
 */
export type DetectionStage =
  | "design-review"
  | "code-review"
  | "unit-test"
  | "integration-test"
  | "e2e-test"
  | "scale-test"
  | "manual-qa"
  | "staging-soak"
  | "not-preventable"
  | "unclassified";

export const DETECTION_STAGES: readonly DetectionStage[] = [
  "design-review",
  "code-review",
  "unit-test",
  "integration-test",
  "e2e-test",
  "scale-test",
  "manual-qa",
  "staging-soak",
  "not-preventable",
  "unclassified",
] as const;

export const DETECTION_STAGE_LABELS: Record<DetectionStage, string> = {
  "design-review": "Design review",
  "code-review": "Code review",
  "unit-test": "Unit test",
  "integration-test": "Integration test",
  "e2e-test": "E2E test",
  "scale-test": "Scale test",
  "manual-qa": "Manual QA",
  "staging-soak": "Staging soak",
  "not-preventable": "Not realistically preventable",
  unclassified: "Unclassified",
};

/** The condition that triggered the defect in the customer's environment. */
export type DefectTrigger =
  | "customer-config"
  | "data-shape"
  | "data-scale"
  | "concurrency"
  | "upgrade-migration"
  | "permissions-auth"
  | "third-party-api-change"
  | "network-infra"
  | "regression"
  | "edge-case-logic"
  | "unknown";

export const DEFECT_TRIGGERS: readonly DefectTrigger[] = [
  "customer-config",
  "data-shape",
  "data-scale",
  "concurrency",
  "upgrade-migration",
  "permissions-auth",
  "third-party-api-change",
  "network-infra",
  "regression",
  "edge-case-logic",
  "unknown",
] as const;

export const TRIGGER_LABELS: Record<DefectTrigger, string> = {
  "customer-config": "Customer configuration",
  "data-shape": "Unexpected data shape",
  "data-scale": "Data volume / scale",
  concurrency: "Concurrency / timing",
  "upgrade-migration": "Upgrade or migration",
  "permissions-auth": "Permissions / auth",
  "third-party-api-change": "3rd-party API change",
  "network-infra": "Network / infrastructure",
  regression: "Regression",
  "edge-case-logic": "Edge-case logic",
  unknown: "Unknown",
};

// ---------------------------------------------------------------------------
// Phase 1 — per-ticket extraction
// ---------------------------------------------------------------------------

/**
 * One ticket's distilled signal. Produced in the extraction phase, consumed by
 * every later phase and by the per-ticket drilldown in the UI.
 */
export interface DefectSignal {
  issueKey: string;
  /** Product area in Veza's own terms, e.g. "Okta connector", "Graph query". */
  area: string | null;
  /** Short phrase naming the failure (e.g. "Pagination token expiry"). */
  failureMode: string;
  /** What the customer actually observed. */
  symptom: string;
  /** Best hypothesis for the underlying cause. */
  suspectedRootCause: string;
  /** The specific condition that had to hold for this to fire. */
  triggerCondition: string;
  trigger: DefectTrigger;
  /** Why our own gates did not catch it before the customer did. */
  escapeReason: string;
  /** The earliest gate that should have caught it. */
  detectionStage: DetectionStage;
  errorSignatures: string[];
  /** Best-guess group/sub-group at extraction time; reconciled during synthesis. */
  category: string;
  subCategory: string;
  isRegression: boolean;
  customerImpact: string;
  /** Customer/business impact, 1-10. */
  severityScore: number;
  /** How preventable this was with better engineering practice, 1-10. */
  preventability: number;
}

// ---------------------------------------------------------------------------
// Phase 2 — synthesis into groups and sub-groups
// ---------------------------------------------------------------------------

export interface RootCause {
  title: string;
  /** Markdown explanation of the underlying cause. */
  explanation: string;
  issueKeys: string[];
  contributingFactors: string[];
}

export interface DefectSubGroup {
  key: string;
  name: string;
  description: string;
  issueKeys: string[];
  ticketCount: number;
  /** Percentage of the PARENT group's tickets (0-100, rounded). */
  share: number;
  topAreas: string[];
  rootCauses: RootCause[];
  exampleQuotes: string[];
  /**
   * Escape-analysis aggregates at sub-group granularity. Sub-groups are where
   * gates actually diverge — "pagination" and "schema drift" sit in the same
   * group but should have been caught by different tests — so the drilldown
   * needs these, not just the group-level rollup.
   */
  detectionStages?: Array<{ stage: DetectionStage; count: number }>;
  triggers?: Array<{ trigger: DefectTrigger; count: number }>;
  severityAvg?: number;
  preventabilityAvg?: number;
  regressionCount?: number;
}

export interface DefectGroup {
  key: string;
  name: string;
  description: string;
  issueKeys: string[];
  ticketCount: number;
  /** Percentage of all analyzed tickets (0-100, rounded). */
  share: number;
  subGroups: DefectSubGroup[];
  rootCauses: RootCause[];
  /** Markdown: what fails, why and how. Filled by the deep-dive phase. */
  analysis: string;
  /** Markdown: why this class escapes our gates. Filled by the deep-dive phase. */
  escapeAnalysis: string;
  topAreas: string[];
  /** Distribution of detection stages within the group, descending by count. */
  detectionStages: Array<{ stage: DetectionStage; count: number }>;
  /** Distribution of triggers within the group, descending by count. */
  triggers: Array<{ trigger: DefectTrigger; count: number }>;
  severityAvg: number;
  preventabilityAvg: number;
  regressionCount: number;
  exampleQuotes: string[];
}

// ---------------------------------------------------------------------------
// Phase 3 — code correlation (deterministic; git + CODEOWNERS)
// ---------------------------------------------------------------------------

export interface FixCommit {
  sha: string;
  subject: string;
  /** ISO date of the commit. */
  date: string;
  files: string[];
  /** Whether the commit touched at least one test file. */
  touchesTests: boolean;
}

/** One ticket's link into the code: the commits that reference its key. */
export interface TicketCodeLink {
  issueKey: string;
  commits: FixCommit[];
  /** Union of CODEOWNERS teams over all touched files. */
  teams: string[];
  /** Distinct files touched across the ticket's fix commits. */
  files: string[];
}

export interface CodeHotspot {
  /** File path or directory, depending on which list this appears in. */
  path: string;
  /**
   * Whether the path still exists at the analyzed HEAD. Hotspots are derived
   * from historical commits, so a hot path may since have been moved or
   * deleted — recommending work on one of those is a wasted action item.
   */
  existsAtHead?: boolean;
  /** Distinct defects whose fixes touched this path. */
  defectCount: number;
  issueKeys: string[];
  teams: string[];
  /** Distinct files under this path (1 for a file hotspot). */
  fileCount: number;
}

export interface TeamCodeStats {
  team: string;
  defectCount: number;
  issueKeys: string[];
  fileCount: number;
  commitCount: number;
  /** Share of the fix commits owned by this team that included a test change. */
  testChangeRate: number;
}

export interface CodeCorrelation {
  repoPath: string;
  /** HEAD sha of the analyzed repo, for reproducibility. */
  repoHead: string | null;
  totalTickets: number;
  /** Tickets with at least one fix commit found in the repo. */
  linkedTickets: number;
  /** linkedTickets / totalTickets as a 0-100 percentage. */
  linkRate: number;
  /** Hottest individual files, descending by defectCount. */
  fileHotspots: CodeHotspot[];
  /** Hottest directories/modules, descending by defectCount. */
  areaHotspots: CodeHotspot[];
  byTeam: TeamCodeStats[];
  links: TicketCodeLink[];
  /** Fix commits that also changed a test file, and those that did not. */
  fixesWithTests: number;
  fixesWithoutTests: number;
  /** Per defect group: where in the code that group lives. */
  byGroup: Array<{
    groupKey: string;
    teams: string[];
    areaHotspots: CodeHotspot[];
    fileHotspots: CodeHotspot[];
    linkedTickets: number;
  }>;
}

// ---------------------------------------------------------------------------
// Phase 4 — prevention strategies and team plans
// ---------------------------------------------------------------------------

export interface PreventionStrategy {
  key: string;
  title: string;
  /** Markdown detail: the concrete change to make. */
  detail: string;
  discipline: PreventionDiscipline;
  /** Owning team — a CODEOWNERS team slug when known, else a function name. */
  team: string;
  /** Defect groups this addresses. */
  groupKeys: string[];
  effort: Effort;
  priority: ActionPriority;
  /** Markdown: the defects this would have prevented, and roughly how many. */
  expectedImpact: string;
  /** Metrics that will show whether this worked. */
  metricKeys: string[];
  /** Code paths this touches, when the correlation identified them. */
  codeAreas: string[];
}

export interface TeamActionPlan {
  /** CODEOWNERS team slug, e.g. "@cookieai-jar/integrations". */
  team: string;
  /** Human label, e.g. "Integrations". */
  label: string;
  defectCount: number;
  issueKeys: string[];
  topGroups: Array<{ groupKey: string; name: string; ticketCount: number }>;
  topAreas: string[];
  /** Markdown: what this team should understand about their defect profile. */
  summary: string;
  strategyKeys: string[];
  metricKeys: string[];
  /**
   * Denormalized from `CodeCorrelation.byTeam` so a team card is readable on
   * its own. `testChangeRate` is the sharpest per-team signal in the report —
   * the share of this team's fix commits that also changed a test.
   */
  testChangeRate?: number;
  commitCount?: number;
}

// ---------------------------------------------------------------------------
// Phase 5 — success metrics, trended over time
// ---------------------------------------------------------------------------

export type MetricDirection = "down-good" | "up-good";
/** Where the metric's value comes from today. */
export type MetricSource = "jira" | "code" | "ci" | "runtime" | "manual";

export const METRIC_SOURCES: readonly MetricSource[] = [
  "jira",
  "code",
  "ci",
  "runtime",
  "manual",
] as const;

/** One period's value. `period` is YYYY-MM for monthly, YYYY-Www for weekly. */
export interface MetricPoint {
  period: string;
  value: number | null;
  numerator?: number;
  denominator?: number;
  /**
   * True for a period that is still in progress. Charts must render these
   * distinctly (dashed/greyed) — an in-flight month is always partially
   * counted and would otherwise read as a genuine drop.
   */
  partial?: boolean;
}

export interface DefectMetric {
  key: string;
  name: string;
  /** Plain-English definition of what is being counted. */
  definition: string;
  /** e.g. "defects/month", "%", "days". */
  unit: string;
  direction: MetricDirection;
  source: MetricSource;
  /** Whether this dashboard computes the value itself today. */
  automated: boolean;
  /** Most recent complete period's value. */
  current: number | null;
  /** Mean of the trailing baseline window, for comparison. */
  baseline: number | null;
  /** Proposed target; null when the analysis did not propose one. */
  target: number | null;
  cadence: "weekly" | "monthly" | "quarterly";
  /** Historical series, oldest first. Backfilled from ticket history. */
  series: MetricPoint[];
  /** Markdown: how to instrument this if it is not automated yet. */
  howToMeasure: string;
  relatedGroupKeys: string[];
}

// ---------------------------------------------------------------------------
// Per-component analysis
// ---------------------------------------------------------------------------

/**
 * One defect group as it appears WITHIN a single JIRA component. Deliberately a
 * reference into the parent report's `groups` rather than a copy — duplicating
 * whole groups across nine components would multiply the stored report for no
 * new information. The UI joins on `groupKey`.
 */
export interface ComponentGroupSlice {
  groupKey: string;
  name: string;
  /** Defects in this component AND this group. */
  ticketCount: number;
  /** Percentage of THIS COMPONENT's defects (0-100, rounded). */
  share: number;
  issueKeys: string[];
  detectionStages: Array<{ stage: DetectionStage; count: number }>;
  triggers: Array<{ trigger: DefectTrigger; count: number }>;
}

/**
 * Everything the per-component dashboard renders. Counts, group slices,
 * metrics and code correlation are computed deterministically from the parent
 * report's signals; only `summary`, `escapeAnalysis` and `strategies` come from
 * the model, and they are what make a component page worth visiting rather than
 * a filtered table.
 *
 * A defect carrying two components appears under both — components are tags,
 * not a partition, so slice counts sum to more than the population.
 */
export interface ComponentAnalysis {
  /** JIRA component name, e.g. "Lifecycle Management". */
  component: string;
  /** URL slug, e.g. "lifecycle-management". */
  slug: string;
  defectCount: number;
  /** Percentage of all analyzed defects (0-100, rounded). */
  share: number;
  issueKeys: string[];
  severityAvg: number;
  preventabilityAvg: number;
  regressionCount: number;
  detectionStages: Array<{ stage: DetectionStage; count: number }>;
  triggers: Array<{ trigger: DefectTrigger; count: number }>;
  /** Product areas and failure modes most seen in this component. */
  topAreas: string[];
  topFailureModes: string[];
  /** This component's defects, bucketed by the report-wide taxonomy. */
  groups: ComponentGroupSlice[];
  /** Markdown, concise: what fails in THIS component and why. */
  summary: string;
  /** Markdown, concise: which gate keeps missing this component's defects. */
  escapeAnalysis: string;
  /** Actions specific to this component. */
  strategies: PreventionStrategy[];
  /** Metric series recomputed over this component's defects only. */
  metrics: DefectMetric[];
  /** Code correlation restricted to this component's defects. */
  codeCorrelation: CodeCorrelation | null;
  /** Teams owning code that this component's defects were fixed in. */
  teams: TeamCodeStats[];
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface ProductDefectAnalysis {
  generatedAt: string;
  /** The JQL the population came from, recorded for reproducibility. */
  jql: string;
  totalTickets: number;
  analyzedTickets: number;
  /** Markdown executive overview for engineering leadership. */
  executiveSummary: string;
  groups: DefectGroup[];
  strategies: PreventionStrategy[];
  metrics: DefectMetric[];
  teamPlans: TeamActionPlan[];
  codeCorrelation: CodeCorrelation | null;
  signals: DefectSignal[];
  /**
   * Per-JIRA-component analyses, descending by defect count. Only components
   * clearing the configured minimum get an entry — below that there is not
   * enough evidence for a pattern, and a thin narrative reads as speculation.
   * Defects in excluded components still count toward everything above.
   */
  components: ComponentAnalysis[];
}

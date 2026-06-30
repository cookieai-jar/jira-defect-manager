/**
 * Domain types for the per-tenant Integrations Health dashboard.
 *
 * Unlike the triage scopes (per-ticket) and Strategic Integrations (cross-ticket
 * pattern report), this dashboard is multi-source observability: Grafana is the
 * spine (tenant + integration inventory + quantitative metrics), Slack supplies
 * alert messages, and JIRA tickets join in via the "Customer" multi-select.
 *
 * Phase 0 establishes the shapes; ingestion is wired incrementally.
 */

/** Quantitative metrics we track per integration. Extend as Grafana metrics are confirmed. */
export type MetricKey =
  | "extraction_duration_s"
  | "parse_duration_s"
  | "node_count"
  | "edge_count"
  | "entity_count"
  | "error_count";

export const METRIC_KEYS: readonly MetricKey[] = [
  "extraction_duration_s",
  "parse_duration_s",
  "node_count",
  "edge_count",
  "entity_count",
  "error_count",
] as const;

export const METRIC_LABELS: Record<MetricKey, string> = {
  extraction_duration_s: "Extraction time",
  parse_duration_s: "Parse time",
  node_count: "Nodes",
  edge_count: "Edges",
  entity_count: "Entities",
  error_count: "Errors",
};

export type Severity = "ok" | "warning" | "critical";

/**
 * Success/fail state of an integration:
 * - failing: recent extraction errors or a critical alert
 * - stalled: outdated datasources or a stuck/pending alert (lag), not failing
 * - idle: no providers/parse activity/alerts
 * - ok: extracting cleanly
 */
export type IntegrationState = "ok" | "failing" | "stalled" | "idle";

/** A tunable threshold: compare one metric against a value, flag at a severity. */
export type ThresholdComparator = "gt" | "gte" | "lt" | "lte";

export interface ThresholdRule {
  metric: MetricKey;
  comparator: ThresholdComparator;
  value: number;
  severity: Exclude<Severity, "ok">;
  /** Human label, e.g. "Extraction SLA (24h)". */
  label: string;
  /** Optional scope: applies only to this integration; undefined = all. */
  integration?: string;
}

/** Result of evaluating a rule against an observed metric value. */
export interface ThresholdBreach {
  metric: MetricKey;
  integration: string;
  observed: number;
  rule: ThresholdRule;
  severity: Exclude<Severity, "ok">;
}

/** Latest observed metric values for one integration on one tenant. */
export interface IntegrationMetrics {
  integration: string;
  /** Metric key -> latest observed value (absent when not reported). */
  values: Partial<Record<MetricKey, number>>;
  /** When the latest extraction completed (ISO), if known. */
  lastExtractionAt: string | null;
}

/** A point in a per-metric time series, for trend charts. */
export interface MetricTrendPoint {
  /** ISO timestamp (bucket start). */
  t: string;
  value: number;
}

export interface MetricTrend {
  integration: string;
  metric: MetricKey;
  points: MetricTrendPoint[];
}

/** Grouped errors for an integration, classified known/unknown by the LLM. */
export interface TenantErrorGroup {
  integration: string;
  signature: string;
  count: number;
  classification: "known" | "unknown";
  /** Short LLM explanation / matched known-error note. */
  summary: string;
  /** JIRA keys correlated to this error. */
  jiraKeys: string[];
}

/** An alert fired for the tenant (from Grafana Alertmanager). */
export interface TenantAlert {
  integration: string | null;
  kind: "extraction" | "parse" | "other";
  name: string;
  state: "firing" | "resolved";
  severity: Severity;
  /** Error reason label when present (e.g. "UNKNOWN", "EXTRACTION_PERMISSION_DENIED"). */
  reason: string | null;
  firedAt: string | null;
  source: "grafana" | "slack";
  url: string | null;
}

/** An incident affecting the tenant (JIRA incident-typed ticket and/or Slack). */
export interface TenantIncident {
  key: string | null;
  summary: string;
  status: string;
  startedAt: string;
  source: "jira" | "slack";
  url: string | null;
}

/** Per-integration roll-up shown as a card. All metrics windowed (see report.windowHours). */
export interface IntegrationHealth {
  /** The agent_type, e.g. "okta", "sharepoint", "awsiam". */
  integration: string;
  /** Distinct providers (accounts/instances) extracting this integration; null when logs unavailable. */
  providers: number | null;
  extractionErrors: number;
  /** Windowed avg parse ms per task (null when no parse tasks in window). */
  parseAvgMs: number | null;
  parseTasks: number;
  /** Derived success/fail state of the integration. */
  state: IntegrationState;
  /** Actively extracting right now (recent START activity). */
  extractingNow: boolean;
  /** Actively parsing right now (recent parser task activity). */
  parsingNow: boolean;
  /** Datasources flagged outdated — the extraction-lag/freshness signal. */
  outdated: number;
  /** Datasources currently failing extraction (cookie_platform_scheduling_error_reasons gauge). */
  failing: number;
  /** Seconds since the last successful parse for this integration (staleness); null if unknown. */
  freshnessSec: number | null;
  /** Seconds the oldest pending extract job has waited (backlog/lag); null if none pending. */
  lagSec: number | null;
  /** Top error_reasons (with internal/user class) for this integration, most frequent first. */
  topReasons: ErrorReason[];
  /** Deep link to the per-connector Grafana dashboard, or null when unconfigured. */
  connectorUrl: string | null;
  /** Deep link to this integration's error logs in Grafana Explore, or null when unconfigured. */
  logsUrl: string | null;
  alerts: TenantAlert[];
  breaches: ThresholdBreach[];
  /** Worst of alerts + breaches, or "ok". */
  severity: Severity;
}

/** A normalized error message + how many times it occurred in the window (Loki-derived; legacy). */
export interface ErrorSignature {
  signature: string;
  count: number;
}

/**
 * A failure grouped by JIRA-grade error_reason + who acts on it. From the
 * authoritative `cookie_platform_scheduling_error_reasons` gauge — `class`
 * "internal" (Veza-side) vs "user" (customer-side) is the key triage axis.
 */
export interface ErrorReason {
  reason: string;
  errorClass: "internal" | "user" | "unknown";
  /** Count of datasources currently in this failure state. */
  count: number;
  /** agent_type, when this is a tenant-level (cross-integration) entry. */
  integration?: string;
  /** Deep link to the matching error logs in Grafana Explore, or null when unconfigured. */
  logsUrl?: string | null;
}

/** One integration's failure signals, sent to the RCA analyzer. */
export interface IntegrationErrorSignals {
  integration: string;
  state: IntegrationState;
  severity: Severity;
  failing: number;
  extractionErrors: number;
  freshnessSec: number | null;
  lagSec: number | null;
  topReasons: ErrorReason[];
}

/** Claude's root-cause analysis for one failing integration. */
export interface ErrorRcaResult {
  integration: string;
  /** One-line summary of what's broken. */
  headline: string;
  /** Who must act: customer (user), Veza (product), or indeterminate. */
  ownership: "user" | "product" | "unknown";
  /** The most probable underlying cause, reasoned from the evidence. */
  rootCause: string;
  /** Short cited signals (reason codes, log/stacktrace fragments) backing the root cause. */
  evidence: string[];
  /** Ordered, concrete remediation steps. */
  fix: string[];
  confidence: "high" | "medium" | "low";
  /** Number of distinct error log samples that informed the analysis. */
  sampleCount: number;
  generatedAt: string;
  /**
   * Fingerprint of the integration's error signals at analysis time. The UI
   * compares it to the current signals to flag the analysis as stale (the
   * failure picture changed since this RCA was generated).
   */
  signalsFingerprint: string;
  /** Present when analysis failed — a degraded placeholder result. */
  error?: string;
}

/** One datasource's authoritative status, from the Metrics DB `datasources` table. */
export interface DatasourceRow {
  name: string;
  datasourceType: string;
  agentType: string;
  syncStatus: string;
  parseStatus: string;
  /** Sync error reason code, when failing. */
  syncError: string | null;
  /** Seconds since the last successful sync; null if never. */
  lastSyncAgeSec: number | null;
  outdated: boolean;
}

/** Authoritative per-datasource health for a tenant, from the Metrics DB. */
export interface DatasourceHealth {
  /** The Metrics DB tenant_id this resolved to (differs from the Grafana slug). */
  dbTenantId: string;
  /** Visible (non-hidden) datasource count — the true total. */
  total: number;
  /** Datasources whose sync_status is not healthy (not SUCCESS/PENDING/IN_PROGRESS). */
  failing: number;
  parseErrors: number;
  outdated: number;
  /** Count by sync_status, most common first (the failure-type breakdown). */
  byStatus: { status: string; count: number }[];
  /** Top sync_error_reason codes among failing datasources. */
  topSyncErrors: { reason: string; count: number }[];
  /** Failing/outdated datasources (capped), worst first. */
  problems: DatasourceRow[];
  /** True when more problem rows exist than the cap shows. */
  problemsTruncated: boolean;
  /** Timestamp (YYYY-MM-DD HH:MM:SS…) of the snapshot the data came from. */
  snapshotAt: string | null;
}

/** A graph node/edge type with its count. */
export interface GraphTypeCount {
  type: string;
  count: number;
}

/** One bucket of the tenant-level extraction-error timeline. */
export interface ErrorTimelinePoint {
  /** ISO timestamp (bucket start). */
  t: string;
  count: number;
}

/** A dynamic-feature-flag change event (from the "Dynamic feature flags updated" log). */
export interface FeatureFlagChange {
  /** ISO timestamp of the change. */
  t: string;
  /** The full flag set after the change. */
  flags: string[];
}

/**
 * Dynamic feature flags for a tenant, recovered from data-plane logs (NRR_*
 * flags only — static env flags aren't logged here).
 */
export interface TenantFeatureFlags {
  /** Latest known flag set. */
  current: string[];
  /** Change events over the window, newest first. */
  changes: FeatureFlagChange[];
}

/** Basic tenant config recovered from Grafana labels + data-plane logs (not the Veza API). */
export interface TenantConfigInfo {
  cluster: string | null;
  /** k8s namespace, "<tenant>-cp". */
  namespace: string | null;
  /** Hosting region, derived from the tenant's regional Loki datasource. */
  region: string | null;
  /** Insight-point (data-plane) version from the "Data plane info" log. */
  insightPointVersion: string | null;
  edpId: string | null;
}

/** Tenant-level Neo4j write volume (write throughput, NOT absolute graph size). */
export interface GraphWrite {
  entityType: string; // "node" | "edge"
  operation: string; // "created" | "modified" | "removed"
  count: number; // over the window
}

/** A JIRA ticket joined to this tenant via the Customer field. */
export interface TenantJiraTicket {
  key: string;
  summary: string;
  status: string;
  /** JIRA priority name (e.g. "P0", "High"), or null when unset. */
  priority: string | null;
  /** Assignee display name, or null when unassigned. */
  assignee: string | null;
  /** True when the ticket's status category is Done. */
  done: boolean;
  url: string;
}

/** A tenant and how it maps across sources. */
export interface Tenant {
  /** Canonical name (the Grafana tenant name). */
  name: string;
  /** Customer-field value(s) used to match JIRA tickets to this tenant. */
  jiraCustomerValues: string[];
}

/** One row in the fleet overview — a lightweight health summary per tenant. */
export interface FleetTenantSummary {
  tenant: string;
  displayName: string;
  /** Extractions over the window. */
  extractions: number;
  extractionErrors: number;
  /** Distinct integrations (agent_types) with activity in the window. */
  integrations: number;
  activeAlerts: number;
  criticalAlerts: number;
  warningAlerts: number;
  healthScore: number;
  severity: Severity;
  /** Single worst issue line, or null when healthy. */
  topIssue: string | null;
  /** True when this tenant maps to a configured white-glove (P0) customer. */
  whiteGlove: boolean;
  /** Extract jobs waiting in the scheduling queue (backlog depth). */
  pendingExtractJobs: number;
  /** Recent health scores oldest→newest (incl. the current one), for a sparkline. */
  trend: number[];
  /** Current score minus the oldest score in the trend window; null with no history. */
  healthDelta: number | null;
}

/** The fleet overview across all tenants. */
export interface FleetReport {
  generatedAt: string;
  windowHours: number;
  /** Sorted worst-health first. */
  tenants: FleetTenantSummary[];
  totals: { tenants: number; unhealthy: number; activeAlerts: number };
  sources: { grafanaMetrics: boolean; grafanaAlerts: boolean };
}

/** The full computed health report for one tenant (persisted as a blob). */
export interface TenantHealthReport {
  /** Grafana tenant_id slug, e.g. "bcgprod". */
  tenant: string;
  /** Display name (JIRA Customer value), e.g. "BCG". Falls back to the slug. */
  displayName: string;
  generatedAt: string;
  /** Metric window the numbers cover. */
  windowHours: number;
  integrations: IntegrationHealth[];
  /** Tenant-level graph write volume over the window. */
  graphWrites: GraphWrite[];
  /** True graph size (neo4j_node_count/edge_count) + top types. */
  graphSize: {
    nodes: number | null;
    edges: number | null;
    topNodeTypes: GraphTypeCount[];
    topEdgeTypes: GraphTypeCount[];
  };
  /** Tenant-level error split by who acts on it (the key triage axis). internal=Veza/product, user=customer, unknown=needs triage. */
  errorClass: { internal: number; user: number; unknown: number };
  /** Deep link to the tenant's error logs in Grafana Explore (regional Loki), or null when unconfigured. */
  errorLogsUrl: string | null;
  /** Tenant-level top error_reasons across integrations, most frequent first. */
  topErrorReasons: ErrorReason[];
  /** Tenant-level extraction-error counts over time, for the timeline chart. */
  errorTimeline: ErrorTimelinePoint[];
  /** Basic tenant config (cluster/region/version), from labels + logs. */
  config: TenantConfigInfo;
  /** Dynamic feature flags + change history, or null when logs unavailable. */
  featureFlags: TenantFeatureFlags | null;
  /** Deep link to the tenant-health Grafana dashboard, or null when unconfigured. */
  healthDashboardUrl: string | null;
  /** All active alerts for the tenant (including non-integration infra alerts). */
  alerts: TenantAlert[];
  /** Known vs unknown error tally (errclass user|internal taxonomy). */
  errorClassification: { known: number; unknown: number };
  /** JIRA tickets joined via the Customer field. */
  jiraTickets: TenantJiraTicket[];
  /** Composite 0-100 health score; higher = healthier. */
  healthScore: number;
  /** Health-score history (oldest→newest) from persisted snapshots, for the trend chart. */
  healthHistory: { t: string; score: number }[];
  /** Authoritative per-datasource health from the Metrics DB, or null when unavailable. */
  datasourceHealth: DatasourceHealth | null;
  /** Ranked top issues (for the header + overview). */
  topIssues: string[];
  /** Headline totals for the summary stats row. */
  totals: {
    integrations: number;
    /** Distinct providers (accounts/instances) extracting for this tenant. */
    providers: number | null;
    /** Total datasources (resources) across the tenant, or null when unavailable. */
    datasources: number | null;
    extractionErrors: number;
    activeAlerts: number;
    /** Extract jobs waiting in the scheduling queue (backlog depth). */
    pendingExtractJobs: number;
  };
  /** Per-source availability for partial-data banners. */
  sources: { grafanaMetrics: boolean; grafanaAlerts: boolean; jira: boolean; loki: boolean };
}

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

/** An alert fired for the tenant (from Grafana alert series and/or Slack). */
export interface TenantAlert {
  integration: string | null;
  kind: "extraction" | "parse" | "other";
  name: string;
  state: "firing" | "resolved";
  firedAt: string;
  source: "grafana" | "slack";
  /** Permalink to the Slack message or Grafana alert, when available. */
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

/** Per-integration roll-up shown as a card. */
export interface IntegrationHealth {
  integration: string;
  metrics: IntegrationMetrics;
  breaches: ThresholdBreach[];
  /** Worst breach severity, or "ok". */
  severity: Severity;
  errorGroups: TenantErrorGroup[];
  alerts: TenantAlert[];
}

/** A tenant and how it maps across sources. */
export interface Tenant {
  /** Canonical name (the Grafana tenant name). */
  name: string;
  /** Customer-field value(s) used to match JIRA tickets to this tenant. */
  jiraCustomerValues: string[];
}

/** The full computed health report for one tenant (persisted as a blob). */
export interface TenantHealthReport {
  tenant: string;
  generatedAt: string;
  integrations: IntegrationHealth[];
  trends: MetricTrend[];
  alerts: TenantAlert[];
  incidents: TenantIncident[];
  /** JIRA tickets associated with this tenant (joined via Customer field). */
  jiraKeys: string[];
  /** Composite 0-100 health score; lower = worse. */
  healthScore: number;
  /** Ranked top issues across the tenant (for the overview + header). */
  topIssues: string[];
  /** Per-source availability so the UI can show partial-data banners. */
  sources: { grafana: boolean; slack: boolean; jira: boolean };
}

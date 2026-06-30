import { queryInstant, fetchActiveAlerts, parseTenantAlerts, parseAlertsByTenant } from "@/lib/grafana";
import { searchIssues } from "@/lib/jira";
import { DEFAULT_THRESHOLDS, evaluateMetrics } from "@/lib/tenant-thresholds";
import type {
  ErrorReason,
  GraphTypeCount,
  FleetReport,
  FleetTenantSummary,
  GraphWrite,
  IntegrationHealth,
  IntegrationMetrics,
  IntegrationState,
  Severity,
  TenantAlert,
  TenantHealthReport,
  TenantJiraTicket,
  ThresholdRule,
} from "@/types/tenant";
import {
  resolveDisplayName,
  makeNameResolver,
  fetchCustomerNames,
  normalizeKey,
  matchCustomerName,
  TENANT_NAME_OVERRIDES,
} from "@/lib/tenant-mapping";
import { extractionLogStats } from "@/lib/tenant-logs";
import { fetchTenantDatasourceHealth } from "@/lib/metrics-db";
import { connectorDetailUrl, tenantHealthDashboardUrl, lokiErrorLogsUrl } from "@/lib/tenant-grafana-links";

/**
 * Per-tenant health report assembly. Grafana is the spine (metrics + alerts),
 * JIRA joins via the Customer field. Heavy lifting is numeric (done here in
 * code); the model is not involved. Pure helpers are unit-tested; buildTenantReport
 * is exercised by a live smoke test.
 */

/** JQL to fetch tickets whose Customer multi-select (customfield_10044) matches. */
export function jiraCustomerJql(displayName: string): string {
  const escaped = displayName.replace(/"/g, '\\"');
  return `cf[10044] = "${escaped}" ORDER BY updated DESC`;
}

/** Firing alert whose name signals a stuck/pending/stalled backlog (extraction or parse). */
export function isStuckAlert(a: TenantAlert): boolean {
  return a.state === "firing" && /stuck|pending|stalled|backlog/i.test(a.name);
}

/**
 * PURE. Derive an integration's success/fail state from its signals.
 * failing > stalled > idle > ok (first match wins).
 */
export function integrationState(ih: {
  extractionErrors: number;
  outdated: number;
  providers: number | null;
  parseTasks: number;
  alerts: TenantAlert[];
}): IntegrationState {
  const firing = ih.alerts.filter((a) => a.state === "firing");
  if (ih.extractionErrors > 0 || firing.some((a) => a.severity === "critical")) return "failing";
  if (ih.outdated > 0 || ih.alerts.some(isStuckAlert)) return "stalled";
  // Strict `=== 0`: when providers is null (regional Loki unavailable) we DON'T
  // know it's idle, so don't badge a possibly-extracting integration "idle".
  if (ih.providers === 0 && ih.parseTasks === 0 && firing.length === 0) return "idle";
  return "ok";
}

/** Normalize the metric `class` label to our error class. */
function normErrorClass(c: string | undefined): "internal" | "user" | "unknown" {
  return c === "internal" || c === "user" ? c : "unknown";
}

export interface ErrorReasonAggregate {
  /** Top error_reasons per integration (agent_type), most frequent first. */
  byIntegration: Map<string, ErrorReason[]>;
  /** Total failing-datasource count per integration. */
  failingByType: Map<string, number>;
  /** Tenant-level split by who acts on the failure (internal=Veza, user=customer, unknown=needs triage). */
  errorClass: { internal: number; user: number; unknown: number };
  /** Tenant-level top error_reasons (with integration), most frequent first. */
  topErrorReasons: ErrorReason[];
}

/**
 * PURE. Aggregate `cookie_platform_scheduling_error_reasons` rows
 * (sum by agent_type, class, error_reason) into per-integration top reasons,
 * per-integration failing totals, the internal/user split, and a tenant-wide
 * top-reasons list. Rows with non-positive counts are dropped.
 */
export function aggregateErrorReasons(
  rows: Array<{ metric: Record<string, string>; value: number }>,
  perIntegration = 3,
  topN = 8,
): ErrorReasonAggregate {
  const all: ErrorReason[] = [];
  for (const r of rows) {
    const count = Math.round(r.value);
    if (count <= 0) continue;
    all.push({
      reason: r.metric.error_reason || "UNKNOWN",
      errorClass: normErrorClass(r.metric.class),
      count,
      integration: r.metric.agent_type || undefined,
    });
  }
  const byInt = new Map<string, ErrorReason[]>();
  const failingByType = new Map<string, number>();
  const errorClass = { internal: 0, user: 0, unknown: 0 };
  for (const e of all) {
    errorClass[e.errorClass] += e.count;
    if (!e.integration) continue;
    failingByType.set(e.integration, (failingByType.get(e.integration) ?? 0) + e.count);
    const list = byInt.get(e.integration) ?? [];
    list.push({ reason: e.reason, errorClass: e.errorClass, count: e.count });
    byInt.set(e.integration, list);
  }
  const sortDesc = (a: ErrorReason, b: ErrorReason) =>
    b.count - a.count ||
    a.reason.localeCompare(b.reason) ||
    (a.integration ?? "").localeCompare(b.integration ?? "");
  const byIntegration = new Map<string, ErrorReason[]>();
  for (const [k, v] of byInt) byIntegration.set(k, [...v].sort(sortDesc).slice(0, perIntegration));
  const topErrorReasons = [...all].sort(sortDesc).slice(0, topN);
  return { byIntegration, failingByType, errorClass, topErrorReasons };
}

/** Worst severity in a set (critical > warning > ok). */
export function worstOf(severities: Severity[]): Severity {
  if (severities.includes("critical")) return "critical";
  if (severities.includes("warning")) return "warning";
  return "ok";
}

/**
 * PURE. Tally known vs unknown errors from the tenant's alerts using the errclass
 * taxonomy: UNKNOWN/INTERNAL reasons (and alert names containing "Unknown" or
 * "Internal") are "unknown"; any other specific error_reason is "known".
 */
export function classifyErrors(alerts: TenantAlert[]): { known: number; unknown: number } {
  let known = 0;
  let unknown = 0;
  for (const a of alerts) {
    const reason = (a.reason ?? "").toUpperCase();
    const unknownish = /unknown|internal/i.test(a.name) || reason === "UNKNOWN" || reason === "INTERNAL";
    if (unknownish) unknown++;
    else if (reason && reason !== "-") known++;
  }
  return { known, unknown };
}

/** Alerts alone can't drop a tenant whose integrations are all healthy below this. */
const ALERT_PENALTY_CAP = 50;

/**
 * PURE. Composite 0-100 health score (higher = healthier). Proportional, so it
 * scales with tenant size and doesn't saturate the way the old fixed
 * -8/errored-integration penalty did (any tenant with ~13+ bad integrations hit 0):
 *
 *   integrationScore = 100 × (1 − unhealthyWeight / totalIntegrations)
 *   score            = integrationScore − min(CAP, 15·critical + 6·warning)
 *
 * `unhealthyWeight` is the summed severity of bad integrations (broken = 1,
 * degraded = 0.5), so half the fleet failing reads as ~50, not 0. The alert
 * penalty is capped so infra alerts can't zero an otherwise-healthy tenant.
 * Clamped to [0, 100]. Shared by the tenant detail and fleet.
 */
export function scoreFromSignals(
  unhealthyWeight: number,
  totalIntegrations: number,
  criticalAlerts: number,
  warningAlerts: number,
): number {
  const frac = totalIntegrations > 0 ? Math.min(1, unhealthyWeight / totalIntegrations) : 0;
  const integrationScore = 100 * (1 - frac);
  const alertPenalty = Math.min(ALERT_PENALTY_CAP, 15 * criticalAlerts + 6 * warningAlerts);
  return Math.max(0, Math.min(100, Math.round(integrationScore - alertPenalty)));
}

/**
 * PURE. How unhealthy one integration is: 1 = broken (failing / critical),
 * 0.5 = degraded (stalled / warning), 0 = healthy or idle. Folds extraction
 * state and alert severity into a single weight for the proportional score.
 */
export function integrationHealthWeight(i: IntegrationHealth): number {
  if (i.severity === "critical" || i.state === "failing") return 1;
  if (i.severity === "warning" || i.state === "stalled") return 0.5;
  return 0;
}

export function computeHealthScore(
  integrations: IntegrationHealth[],
  alerts: TenantAlert[],
): number {
  // Integration-attached alerts already flow into each integration's weight via
  // its severity, so only infra (non-integration) alerts feed the alert penalty —
  // avoids double-counting the same failure.
  const infraFiring = alerts.filter((a) => a.state === "firing" && !a.integration);
  const unhealthyWeight = integrations.reduce((sum, i) => sum + integrationHealthWeight(i), 0);
  return scoreFromSignals(
    unhealthyWeight,
    integrations.length,
    infraFiring.filter((a) => a.severity === "critical").length,
    infraFiring.filter((a) => a.severity === "warning").length,
  );
}

/** A tenant's overall worst firing-alert severity (ok when none firing). */
function worstFiringSeverity(alerts: TenantAlert[]): Severity {
  return worstOf(alerts.filter((a) => a.state === "firing").map((a) => a.severity));
}

/** One firing alert formatted as a short issue line. */
function alertIssueLine(a: TenantAlert): string {
  const who = a.integration ? `${a.integration}: ` : "";
  const why = a.reason && a.reason !== "-" ? ` (${a.reason})` : "";
  return `${who}${a.name}${why}`;
}

interface FleetInputs {
  /** Per (tenant, agent_type) extraction volume over the window. */
  extractionRows: Array<{ tenant: string; agent: string; value: number }>;
  /** Per (tenant, agent_type) extraction error volume — shown as the "Errors" total. */
  errorRows: Array<{ tenant: string; agent: string; value: number }>;
  /**
   * Per (tenant, agent_type) currently-failing datasources, from the authoritative
   * `cookie_platform_scheduling_error_reasons` gauge — the SAME signal the detail
   * page weights, so fleet & detail rank tenants consistently. Drives the score.
   */
  failingRows: Array<{ tenant: string; agent: string; value: number }>;
  /** Per-tenant alerts. */
  alertsByTenant: Map<string, TenantAlert[]>;
  /** Per-tenant pending extract-queue depth (backlog). */
  pendingByTenant?: Map<string, number>;
  /** Per-tenant prior health-score history (oldest→newest), for trend + delta. */
  historyByTenant?: Map<string, Array<{ t: string; score: number }>>;
}

/**
 * PURE. Recent scores (incl. current) capped to the last `cap` points, plus the
 * delta vs the OLDEST POINT SHOWN — so the badge and the sparkline always share a
 * baseline (delta = current − trend[0], never an off-screen point).
 */
export function trendAndDelta(
  history: Array<{ t: string; score: number }>,
  current: number,
  cap = 24,
): { trend: number[]; healthDelta: number | null } {
  const trend = [...history.map((h) => h.score), current].slice(-cap);
  const healthDelta = trend.length > 1 ? current - trend[0] : null;
  return { trend, healthDelta };
}

/**
 * PURE. Build the fleet summary rows from aggregate (by-tenant) inputs. Universe
 * is the union of tenants seen in metrics + alerts. Sorted worst-health first,
 * then most active alerts, then name.
 */
export function buildFleetSummaries(
  inputs: FleetInputs,
  resolveName: (slug: string) => string = (s) => resolveDisplayName(s),
  /** Whether a tenant slug maps to a white-glove customer (real match only — no prettify fallback). */
  isWhiteGlove: (slug: string) => boolean = () => false,
): FleetTenantSummary[] {
  const extractionsByTenant = new Map<string, number>();
  const integrationsByTenant = new Map<string, Set<string>>();
  for (const r of inputs.extractionRows) {
    extractionsByTenant.set(r.tenant, (extractionsByTenant.get(r.tenant) ?? 0) + r.value);
    const set = integrationsByTenant.get(r.tenant) ?? new Set<string>();
    set.add(r.agent);
    integrationsByTenant.set(r.tenant, set);
  }

  // Per-tenant error volume total (display only).
  const errorsByTenant = new Map<string, number>();
  for (const r of inputs.errorRows) {
    errorsByTenant.set(r.tenant, (errorsByTenant.get(r.tenant) ?? 0) + r.value);
  }
  // Set of failing integrations per tenant (authoritative gauge) — drives the score.
  const failingAgentsByTenant = new Map<string, Set<string>>();
  for (const r of inputs.failingRows) {
    if (r.value > 0) {
      const set = failingAgentsByTenant.get(r.tenant) ?? new Set<string>();
      set.add(r.agent);
      failingAgentsByTenant.set(r.tenant, set);
    }
  }

  const tenants = new Set<string>([
    ...extractionsByTenant.keys(),
    ...errorsByTenant.keys(),
    ...failingAgentsByTenant.keys(),
    ...inputs.alertsByTenant.keys(),
  ]);

  const rankSev: Record<Severity, number> = { critical: 0, warning: 1, ok: 2 };
  const rows: FleetTenantSummary[] = [...tenants].map((tenant) => {
    const alerts = inputs.alertsByTenant.get(tenant) ?? [];
    const firing = alerts.filter((a) => a.state === "firing");
    const criticalAlerts = firing.filter((a) => a.severity === "critical").length;
    const warningAlerts = firing.filter((a) => a.severity === "warning").length;
    const extractionErrors = Math.round(errorsByTenant.get(tenant) ?? 0);
    const failingAgents = failingAgentsByTenant.get(tenant) ?? new Set<string>();

    // Mirror the detail page's model: fold integration-attached alerts into the
    // integration universe + weight (worst severity per agent wins), and reserve
    // infra (non-integration) alerts for the capped penalty. Keeps detail & fleet
    // scores consistent for the same tenant.
    const universe = new Set<string>([...(integrationsByTenant.get(tenant) ?? []), ...failingAgents]);
    const intAlertSev = new Map<string, "critical" | "warning">();
    for (const a of firing) {
      if (a.integration && (a.severity === "critical" || a.severity === "warning")) {
        universe.add(a.integration);
        if (intAlertSev.get(a.integration) !== "critical") intAlertSev.set(a.integration, a.severity);
      }
    }
    let unhealthyWeight = 0;
    for (const agent of universe) {
      if (failingAgents.has(agent) || intAlertSev.get(agent) === "critical") unhealthyWeight += 1;
      else if (intAlertSev.get(agent) === "warning") unhealthyWeight += 0.5;
    }
    const infraFiring = firing.filter((a) => !a.integration);

    const worstAlert = [...firing].sort((a, b) => rankSev[a.severity] - rankSev[b.severity])[0];
    const topIssue = worstAlert
      ? alertIssueLine(worstAlert)
      : extractionErrors > 0
        ? `${extractionErrors} extraction error${extractionErrors === 1 ? "" : "s"}`
        : null;
    const displayName = resolveName(tenant);
    const score = scoreFromSignals(
      unhealthyWeight,
      universe.size,
      infraFiring.filter((a) => a.severity === "critical").length,
      infraFiring.filter((a) => a.severity === "warning").length,
    );
    const { trend, healthDelta } = trendAndDelta(inputs.historyByTenant?.get(tenant) ?? [], score);
    return {
      tenant,
      displayName,
      extractions: Math.round(extractionsByTenant.get(tenant) ?? 0),
      extractionErrors,
      integrations: universe.size,
      activeAlerts: firing.length,
      criticalAlerts,
      warningAlerts,
      healthScore: score,
      severity: worstFiringSeverity(alerts),
      topIssue,
      whiteGlove: isWhiteGlove(tenant),
      pendingExtractJobs: Math.round(inputs.pendingByTenant?.get(tenant) ?? 0),
      trend,
      healthDelta,
    };
  });

  return rows.sort(
    (a, b) =>
      a.healthScore - b.healthScore ||
      b.activeAlerts - a.activeAlerts ||
      a.displayName.localeCompare(b.displayName),
  );
}

/** PURE. Ranked human-readable top issues (critical first), capped at `limit`. */
export function buildTopIssues(
  integrations: IntegrationHealth[],
  alerts: TenantAlert[],
  limit = 6,
): string[] {
  const rank: Record<Severity, number> = { critical: 0, warning: 1, ok: 2 };
  const fromAlerts = [...alerts]
    .filter((a) => a.state === "firing" && a.severity !== "ok")
    .sort((a, b) => rank[a.severity] - rank[b.severity])
    .map((a) => {
      const who = a.integration ? `${a.integration}: ` : "";
      const why = a.reason && a.reason !== "-" ? ` (${a.reason})` : "";
      return `${who}${a.name}${why}`;
    });
  const fromErrors = integrations
    .filter((i) => i.extractionErrors > 0)
    .sort((a, b) => b.extractionErrors - a.extractionErrors)
    .map((i) => `${i.integration}: ${i.extractionErrors} extraction error${i.extractionErrors === 1 ? "" : "s"}`);
  return [...new Set([...fromAlerts, ...fromErrors])].slice(0, limit);
}

interface IntegrationInputs {
  /** Base integration types (from the extraction metric) — the inventory. */
  inventory: string[];
  /** Distinct providers per integration (from logs); empty when logs unavailable. */
  providers: Map<string, number>;
  /** Whether provider data is present (logs available) — distinguishes 0 from "unknown". */
  hasProviderData: boolean;
  extractionErrors: Map<string, number>;
  parseDurationMs: Map<string, number>;
  parseTasks: Map<string, number>;
  alertsByIntegration: Map<string, TenantAlert[]>;
  /** Outdated-datasource count per integration (extraction lag); keys lowercased. */
  outdatedByType: Map<string, number>;
  /** Integration types extracting right now (in-progress extract queue). */
  extractingNowTypes: Set<string>;
  /** Integration types parsing right now (recent parser task activity). */
  parsingNowTypes: Set<string>;
  /** Currently-failing-datasource count per integration (scheduling_error_reasons gauge). */
  failingByType: Map<string, number>;
  /** Top error_reasons per integration. */
  topReasonsByType: Map<string, ErrorReason[]>;
  /** Seconds since last successful parse per integration. */
  freshnessByType: Map<string, number>;
  /** Oldest pending extract-job age (seconds) per integration. */
  lagByType: Map<string, number>;
  /** Builds the per-connector drill-down URL for an integration (null when unconfigured). */
  connectorUrl: (integration: string) => string | null;
  /** Builds the error-logs Explore URL for an integration (null when unconfigured). */
  logsUrl: (integration: string) => string | null;
}

/**
 * PURE. Combine inventory + per-integration provider/error/parse data + grouped
 * alerts into IntegrationHealth[]. Inventory = base connectors (metric extraction
 * agent_types ∪ provider keys ∪ non-CSC parse agent_types); CSC pair series
 * (containing "-") are excluded as relationship-parse. Sorted by severity, then
 * provider count, then name.
 */
export function buildIntegrationHealth(
  inputs: IntegrationInputs,
  rules: ThresholdRule[] = DEFAULT_THRESHOLDS,
): IntegrationHealth[] {
  const names = new Set<string>(inputs.inventory);
  for (const k of inputs.providers.keys()) names.add(k);
  for (const k of inputs.parseTasks.keys()) if (!k.includes("-")) names.add(k);
  // Anything actively running NOW must get a row even if it had no completed
  // extractions/providers/parse in the window — otherwise an integration that's
  // stuck in-progress (e.g. a huge pending backlog) silently vanishes from the
  // table and its "extracting/parsing now" status is lost.
  for (const k of inputs.extractingNowTypes) if (!k.includes("-")) names.add(k);
  for (const k of inputs.parsingNowTypes) if (!k.includes("-")) names.add(k);

  const rankSev: Record<Severity, number> = { critical: 0, warning: 1, ok: 2 };
  const rows: IntegrationHealth[] = [...names].map((integration) => {
    const providers = inputs.hasProviderData ? Math.round(inputs.providers.get(integration) ?? 0) : null;
    const extractionErrors = Math.round(inputs.extractionErrors.get(integration) ?? 0);
    const rawTasks = inputs.parseTasks.get(integration) ?? 0;
    const parseTasks = Math.round(rawTasks);
    const durMs = inputs.parseDurationMs.get(integration) ?? 0;
    const parseAvgMs = rawTasks > 0 ? Math.round(durMs / rawTasks) : null;
    const alerts = inputs.alertsByIntegration.get(integration) ?? [];

    const metrics: IntegrationMetrics = {
      integration,
      values: {
        error_count: extractionErrors,
        ...(parseAvgMs != null ? { parse_duration_s: parseAvgMs / 1000 } : {}),
      },
      lastExtractionAt: null,
    };
    const breaches = evaluateMetrics(metrics, rules);
    const severity = worstOf([
      ...alerts.map((a) => a.severity),
      ...breaches.map((b) => b.severity),
    ]);
    const outdated = Math.round(inputs.outdatedByType.get(integration) ?? 0);
    const failing = Math.round(inputs.failingByType.get(integration) ?? 0);
    const topReasons = inputs.topReasonsByType.get(integration) ?? [];
    const freshnessSec = inputs.freshnessByType.has(integration)
      ? Math.round(inputs.freshnessByType.get(integration)!)
      : null;
    const lagSec = inputs.lagByType.has(integration) ? Math.round(inputs.lagByType.get(integration)!) : null;
    // state reflects the authoritative failing-datasource gauge as well as Loki errors.
    const state = integrationState({ extractionErrors: extractionErrors + failing, outdated, providers, parseTasks, alerts });
    return {
      integration,
      providers,
      extractionErrors,
      parseAvgMs,
      parseTasks,
      state,
      extractingNow: inputs.extractingNowTypes.has(integration),
      parsingNow: inputs.parsingNowTypes.has(integration),
      outdated,
      failing,
      freshnessSec,
      lagSec,
      topReasons,
      connectorUrl: inputs.connectorUrl(integration),
      logsUrl: inputs.logsUrl(integration),
      alerts,
      breaches,
      severity,
    };
  });

  return rows.sort((a, b) => {
    const s = rankSev[a.severity] - rankSev[b.severity];
    return s !== 0 ? s : (b.providers ?? 0) - (a.providers ?? 0) || a.integration.localeCompare(b.integration);
  });
}

/** Reduce a Prometheus instant result into a label -> value map. */
function byLabel(
  result: Array<{ metric: Record<string, string>; value: number }>,
  label: string,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of result) {
    const k = r.metric[label];
    if (k) m.set(k, (m.get(k) ?? 0) + r.value);
  }
  return m;
}

export interface BuildOptions {
  windowHours?: number;
  jiraLimit?: number;
}

/**
 * Assemble the full health report for one tenant. Each source is independently
 * guarded so a single outage degrades to partial data rather than failing.
 */
export async function buildTenantReport(
  tenant: string,
  opts: BuildOptions = {},
): Promise<TenantHealthReport> {
  const windowHours = opts.windowHours ?? 24;
  const w = `${windowHours}h`;
  const sel = `{tenant_id="${tenant}"}`;
  const selBare = `tenant_id="${tenant}"`; // for queries that add other label matchers
  const customers = await fetchCustomerNames();
  const displayName = resolveDisplayName(tenant, customers);

  const sources = { grafanaMetrics: false, grafanaAlerts: false, jira: false, loki: false };

  // --- Grafana metrics (instant, windowed increase) ---
  // The extraction metric is used only for the integration INVENTORY (which
  // connectors exist); per-integration counts come from logs (distinct providers).
  let inventory: string[] = [];
  let extractionErrors = new Map<string, number>();
  let parseDurationMs = new Map<string, number>();
  let parseTasks = new Map<string, number>();
  let graphWrites: GraphWrite[] = [];
  let datasources: number | null = null;
  let outdatedByType = new Map<string, number>();
  let parsingNowTypes = new Set<string>();
  let cluster: string | null = null;
  let namespace: string | null = null;
  let errAgg: ReturnType<typeof aggregateErrorReasons> | null = null;
  let freshnessByType = new Map<string, number>();
  let lagByType = new Map<string, number>();
  let extractingNowTypes = new Set<string>();
  let pendingExtractJobs = 0;
  let graphSize: TenantHealthReport["graphSize"] = {
    nodes: null,
    edges: null,
    topNodeTypes: [],
    topEdgeTypes: [],
  };
  try {
    const [ext, err, dur, tasks, writes, dsCount, outdated, parsingNow, uptime, errReasons, freshness, lag, queueExtract, queuePending, neoNodes, neoEdges, neoNodeType, neoEdgeType] = await Promise.all([
      queryInstant(`sum by (agent_type) (increase(veza_platform_extraction_total${sel}[${w}]))`),
      queryInstant(`sum by (agent_type) (increase(veza_platform_extraction_errors_total${sel}[${w}]))`),
      queryInstant(`sum by (agent_type) (increase(veza_platform_parser_task_duration_ms_total${sel}[${w}]))`),
      queryInstant(`sum by (agent_type) (increase(veza_platform_parser_task_total${sel}[${w}]))`),
      queryInstant(`sum by (entity_type, operation) (increase(veza_platform_parser_neo4j_writes_total${sel}[${w}]))`),
      // datasource_count has duplicate series per pod — max() dedupes.
      queryInstant(`max(cookie_platform_datasource_count${sel})`),
      // outdated datasources = extraction lag; agent_type label is UPPERCASE here.
      queryInstant(`sum by (agent_type) (veza_platform_datasources_flagged_outdated_total${sel})`),
      // recent parse activity = "parsing right now".
      queryInstant(`sum by (agent_type) (increase(veza_platform_parser_task_total${sel}[10m]))`),
      // label-bearing series for tenant config (cluster/namespace).
      queryInstant(`veza_platform_parser_uptime_ms${sel}`),
      // authoritative failures: currently-failing datasources by class + error_reason.
      queryInstant(`sum by (agent_type, class, error_reason) (cookie_platform_scheduling_error_reasons{stage="extract", ${selBare}})`),
      // freshness: seconds since last successful parse, per integration.
      queryInstant(`time() - max by (agent_type) (cookie_platform_scheduling_parsed_at_success_ms_max${sel}) / 1000`),
      // lag: oldest pending extract job age (seconds), per integration.
      queryInstant(`time() - max by (agent_type) (cookie_platform_scheduling_extract_jobs_pending_oldest_time_ms${sel}) / 1000`),
      // running now: in-progress extract jobs, per integration.
      queryInstant(`sum by (agent_type) (cookie_platform_scheduling_queue_size{state="in-progress", stage="extract", ${selBare}})`),
      // backlog: extract jobs waiting in the queue (tenant-wide).
      queryInstant(`sum(cookie_platform_scheduling_queue_size{state="pending", stage="extract", ${selBare}})`),
      // true graph size (per tenant).
      queryInstant(`sum(neo4j_node_count${sel})`),
      queryInstant(`sum(neo4j_edge_count${sel})`),
      queryInstant(`topk(12, sum by (node_type) (neo4j_node_count${sel}))`),
      queryInstant(`topk(12, sum by (edge_type) (neo4j_edge_count${sel}))`),
    ]);
    inventory = [...byLabel(ext, "agent_type").keys()];
    extractionErrors = byLabel(err, "agent_type");
    parseDurationMs = byLabel(dur, "agent_type");
    parseTasks = byLabel(tasks, "agent_type");
    graphWrites = writes
      .map((r) => ({ entityType: r.metric.entity_type ?? "?", operation: r.metric.operation ?? "?", count: Math.round(r.value) }))
      .sort((a, b) => b.count - a.count);
    datasources = dsCount.length > 0 ? Math.round(dsCount[0].value) : null;
    for (const r of outdated) {
      const k = (r.metric.agent_type ?? "").toLowerCase(); // match lowercase inventory keys
      if (k) outdatedByType.set(k, (outdatedByType.get(k) ?? 0) + r.value);
    }
    // >= 1: increase() extrapolation can return a small fraction at series
    // boundaries without a real increment in the window.
    parsingNowTypes = new Set(
      parsingNow.filter((r) => r.value >= 1 && r.metric.agent_type).map((r) => r.metric.agent_type),
    );
    // uptime returns one series per parser pod; pick the longest-running (live)
    // one's cluster rather than an arbitrary [0] (avoids a stale cross-cluster
    // series after a migration). namespace is deterministic for the control plane.
    const liveUptime = [...uptime].sort((a, b) => b.value - a.value)[0];
    cluster = liveUptime?.metric.cluster ?? liveUptime?.metric.k8s_cluster_name ?? null;
    namespace = `${tenant}-cp`;

    // Authoritative failures (scheduling_error_reasons gauge): class + error_reason.
    errAgg = aggregateErrorReasons(errReasons);
    // Clamp negatives: clock skew can make (time() - ts) slightly negative for a
    // just-now success/pending — treat as 0 age, not "-2s".
    for (const r of freshness) if (r.metric.agent_type && Number.isFinite(r.value)) freshnessByType.set(r.metric.agent_type, Math.max(0, r.value));
    for (const r of lag) if (r.metric.agent_type && Number.isFinite(r.value)) lagByType.set(r.metric.agent_type, Math.max(0, r.value));
    // running now: in-progress extract queue (replaces the Loki START approximation).
    extractingNowTypes = new Set(
      queueExtract.filter((r) => r.value >= 1 && r.metric.agent_type).map((r) => r.metric.agent_type),
    );
    pendingExtractJobs = queuePending.length > 0 ? Math.round(Math.max(0, queuePending[0].value)) : 0;
    graphSize = {
      nodes: neoNodes.length > 0 ? Math.round(neoNodes[0].value) : null,
      edges: neoEdges.length > 0 ? Math.round(neoEdges[0].value) : null,
      topNodeTypes: neoNodeType
        .map((r) => ({ type: r.metric.node_type ?? "?", count: Math.round(r.value) }))
        .sort((a, b) => b.count - a.count),
      topEdgeTypes: neoEdgeType
        .map((r) => ({ type: r.metric.edge_type ?? "?", count: Math.round(r.value) }))
        .sort((a, b) => b.count - a.count),
    };
    sources.grafanaMetrics = true;
  } catch (e) {
    console.warn(`[tenant-health] metrics query failed for ${tenant}:`, e instanceof Error ? e.message : e);
  }

  // --- Grafana alerts ---
  let alerts: TenantAlert[] = [];
  try {
    alerts = parseTenantAlerts(await fetchActiveAlerts(), tenant);
    sources.grafanaAlerts = true;
  } catch (e) {
    console.warn(`[tenant-health] alerts query failed for ${tenant}:`, e instanceof Error ? e.message : e);
  }
  const alertsByIntegration = new Map<string, TenantAlert[]>();
  for (const a of alerts) {
    if (!a.integration) continue;
    const list = alertsByIntegration.get(a.integration) ?? [];
    list.push(a);
    alertsByIntegration.set(a.integration, list);
  }

  // --- Log-based provider counts (the per-integration "Providers" number) ---
  // Distinct providers (accounts/instances) actively extracting per integration,
  // from the tenant's regional Loki. Errors also come from logs when available.
  let providers = new Map<string, number>();
  let totalProviders: number | null = null;
  let hasProviderData = false;
  let errorTimeline: TenantHealthReport["errorTimeline"] = [];
  let region: string | null = null;
  let logsDsUid: string | null = null;
  let featureFlags: TenantHealthReport["featureFlags"] = null;
  let dataPlane = { insightPointVersion: null as string | null, edpId: null as string | null };
  try {
    const logs = await extractionLogStats(tenant, inventory, windowHours);
    if (logs.dsUid) {
      logsDsUid = logs.dsUid;
      providers = logs.providersByType;
      totalProviders = logs.totalProviders;
      hasProviderData = true;
      if (logs.errorByType.size > 0) extractionErrors = logs.errorByType;
      errorTimeline = logs.errorTimeline;
      region = logs.region;
      featureFlags = logs.featureFlags;
      dataPlane = logs.dataPlane;
      sources.loki = true;
    }
  } catch (e) {
    console.warn(`[tenant-health] provider-log count failed for ${tenant}:`, e instanceof Error ? e.message : e);
  }

  const grafanaBase = process.env.GRAFANA_URL ?? null;
  const integrations = buildIntegrationHealth({
    inventory,
    providers,
    hasProviderData,
    extractionErrors,
    parseDurationMs,
    parseTasks,
    alertsByIntegration,
    outdatedByType,
    extractingNowTypes,
    parsingNowTypes,
    failingByType: errAgg?.failingByType ?? new Map(),
    topReasonsByType: errAgg?.byIntegration ?? new Map(),
    freshnessByType,
    lagByType,
    connectorUrl: (integration) => connectorDetailUrl(grafanaBase, tenant, integration),
    logsUrl: (integration) => lokiErrorLogsUrl(grafanaBase, logsDsUid, tenant, integration, windowHours),
  });

  // --- JIRA tickets (Customer field join) ---
  let jiraTickets: TenantJiraTicket[] = [];
  try {
    const issues = await searchIssues(jiraCustomerJql(displayName), opts.jiraLimit ?? 50);
    jiraTickets = issues.map((i) => ({
      key: i.key,
      summary: i.summary,
      status: i.status,
      priority: i.priority,
      assignee: i.assignee,
      done: i.statusCategory === "done",
      url: i.url,
    }));
    sources.jira = true;
  } catch (e) {
    console.warn(`[tenant-health] JIRA query failed for ${tenant}:`, e instanceof Error ? e.message : e);
  }

  const totalErrors = [...extractionErrors.values()].reduce((n, v) => n + v, 0);

  // Health-score history (persisted by the fleet computation), for the trend chart.
  let healthHistory: TenantHealthReport["healthHistory"] = [];
  try {
    const dbMod = await import("@/lib/db");
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    healthHistory = dbMod.listHealthSnapshots(tenant, since);
  } catch (e) {
    console.warn(`[tenant-health] health history load failed for ${tenant}:`, e instanceof Error ? e.message : e);
  }

  // Authoritative per-datasource health from the Metrics DB (best-effort).
  let datasourceHealth: TenantHealthReport["datasourceHealth"] = null;
  try {
    // Pass the Grafana integration inventory so a normalization collision that
    // resolves to a different customer's id is rejected (no integration overlap).
    datasourceHealth = await fetchTenantDatasourceHealth(tenant, inventory);
  } catch (e) {
    console.warn(`[tenant-health] datasource-health load failed for ${tenant}:`, e instanceof Error ? e.message : e);
  }

  return {
    tenant,
    displayName,
    generatedAt: new Date().toISOString(),
    windowHours,
    integrations,
    graphWrites,
    graphSize,
    errorClass: errAgg?.errorClass ?? { internal: 0, user: 0, unknown: 0 },
    topErrorReasons: (errAgg?.topErrorReasons ?? []).map((r) => ({
      ...r,
      logsUrl: lokiErrorLogsUrl(grafanaBase, logsDsUid, tenant, r.integration ?? null, windowHours),
    })),
    errorLogsUrl: lokiErrorLogsUrl(grafanaBase, logsDsUid, tenant, null, windowHours),
    errorTimeline,
    config: {
      cluster,
      namespace,
      region,
      insightPointVersion: dataPlane.insightPointVersion,
      edpId: dataPlane.edpId,
    },
    featureFlags,
    healthDashboardUrl: tenantHealthDashboardUrl(grafanaBase),
    alerts,
    errorClassification: classifyErrors(alerts),
    jiraTickets,
    healthScore: computeHealthScore(integrations, alerts),
    healthHistory,
    datasourceHealth,
    topIssues: buildTopIssues(integrations, alerts),
    totals: {
      integrations: integrations.length,
      providers: totalProviders,
      // Prefer the Metrics DB's authoritative visible-datasource count (the
      // exact per-row truth) over the metric gauge; fall back to the metric.
      datasources: datasourceHealth?.total ?? datasources,
      extractionErrors: Math.round(totalErrors),
      activeAlerts: alerts.filter((a) => a.state === "firing").length,
      pendingExtractJobs,
    },
    sources,
  };
}

/**
 * Assemble the fleet overview across ALL tenants in a handful of aggregate
 * queries (NOT one report per tenant): 2 by-(tenant) PromQL queries + 1 alerts
 * fetch. JIRA is intentionally skipped here (per-tenant; done on drill-in).
 */
export async function buildFleet(opts: BuildOptions = {}): Promise<FleetReport> {
  const windowHours = opts.windowHours ?? 24;
  const w = `${windowHours}h`;
  const sources = { grafanaMetrics: false, grafanaAlerts: false };

  let extractionRows: Array<{ tenant: string; agent: string; value: number }> = [];
  let errorRows: Array<{ tenant: string; agent: string; value: number }> = [];
  let failingRows: Array<{ tenant: string; agent: string; value: number }> = [];
  const pendingByTenant = new Map<string, number>();
  try {
    const toRows = (rows: Awaited<ReturnType<typeof queryInstant>>) =>
      rows
        .filter((r) => r.metric.tenant_id)
        .map((r) => ({ tenant: r.metric.tenant_id, agent: r.metric.agent_type ?? "?", value: r.value }));
    const [ext, err, failing, pending] = await Promise.all([
      queryInstant(`sum by (tenant_id, agent_type) (increase(veza_platform_extraction_total[${w}]))`),
      queryInstant(`sum by (tenant_id, agent_type) (increase(veza_platform_extraction_errors_total[${w}]))`),
      // authoritative currently-failing datasources (same gauge the detail page weights)
      queryInstant(`sum by (tenant_id, agent_type) (cookie_platform_scheduling_error_reasons{stage="extract"})`),
      // backlog: pending extract-queue depth per tenant
      queryInstant(`sum by (tenant_id) (cookie_platform_scheduling_queue_size{state="pending", stage="extract"})`),
    ]);
    extractionRows = toRows(ext);
    errorRows = toRows(err);
    failingRows = toRows(failing);
    for (const r of pending) if (r.metric.tenant_id) pendingByTenant.set(r.metric.tenant_id, r.value);
    sources.grafanaMetrics = true;
  } catch (e) {
    console.warn("[tenant-health] fleet metrics query failed:", e instanceof Error ? e.message : e);
  }

  let alertsByTenant = new Map<string, TenantAlert[]>();
  try {
    alertsByTenant = parseAlertsByTenant(await fetchActiveAlerts());
    sources.grafanaAlerts = true;
  } catch (e) {
    console.warn("[tenant-health] fleet alerts query failed:", e instanceof Error ? e.message : e);
  }

  const customers = await fetchCustomerNames();
  const generatedAt = new Date().toISOString();
  // White-glove customers + health-score history. Dynamic import keeps node:sqlite
  // out of this module's static graph (so the pure helpers stay unit-testable).
  let whiteGloveKeys = new Set<string>();
  let historyByTenant = new Map<string, Array<{ t: string; score: number }>>();
  let dbMod: typeof import("@/lib/db") | null = null;
  try {
    dbMod = await import("@/lib/db");
    whiteGloveKeys = new Set(dbMod.listP0().map((c) => normalizeKey(c.name)).filter(Boolean));
    // 48h window: the fleet sparkline caps at 24 points, so a tighter scan avoids
    // materializing the full 7d × all-tenants set on this hot path.
    const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    historyByTenant = dbMod.snapshotsByTenantSince(since);
  } catch (e) {
    console.warn("[tenant-health] white-glove/history load failed:", e instanceof Error ? e.message : e);
  }
  // Match on the REAL customer name (override or customer-field match), never the
  // prettified-slug fallback — otherwise an unmatched slug could spuriously match
  // a white-glove name (e.g. slug "acme" → "Acme").
  const isWhiteGlove = (slug: string): boolean => {
    if (whiteGloveKeys.size === 0) return false;
    const matched = TENANT_NAME_OVERRIDES[slug] ?? matchCustomerName(slug, customers);
    return matched != null && whiteGloveKeys.has(normalizeKey(matched));
  };
  const tenants = buildFleetSummaries(
    { extractionRows, errorRows, failingRows, alertsByTenant, pendingByTenant, historyByTenant },
    makeNameResolver(customers),
    isWhiteGlove,
  );

  // Record a snapshot per tenant, throttled to ~hourly so frequent page loads
  // don't spam points; prune to a 30-day window. Best-effort.
  try {
    if (dbMod && sources.grafanaMetrics && tenants.length > 0) {
      const last = dbMod.latestSnapshotTs();
      const THROTTLE_MS = 50 * 60 * 1000;
      if (!last || Date.now() - new Date(last).getTime() > THROTTLE_MS) {
        dbMod.recordHealthSnapshots(
          tenants.map((t) => ({ tenant: t.tenant, score: t.healthScore })),
          generatedAt,
        );
        dbMod.pruneHealthSnapshots(new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString());
      }
    }
  } catch (e) {
    console.warn("[tenant-health] snapshot write failed:", e instanceof Error ? e.message : e);
  }

  return {
    generatedAt,
    windowHours,
    tenants,
    totals: {
      tenants: tenants.length,
      // "Unhealthy" = the red tier (<50); matches healthTone, and avoids flagging
      // every tenant with a single failing datasource now that scores are proportional.
      unhealthy: tenants.filter((t) => t.healthScore < 50).length,
      activeAlerts: tenants.reduce((n, t) => n + t.activeAlerts, 0),
    },
    sources,
  };
}

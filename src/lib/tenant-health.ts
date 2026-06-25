import { queryInstant, fetchActiveAlerts, parseTenantAlerts, parseAlertsByTenant } from "@/lib/grafana";
import { searchIssues } from "@/lib/jira";
import { DEFAULT_THRESHOLDS, evaluateMetrics } from "@/lib/tenant-thresholds";
import type {
  ErrorSignature,
  FleetReport,
  FleetTenantSummary,
  GraphWrite,
  IntegrationHealth,
  IntegrationMetrics,
  Severity,
  TenantAlert,
  TenantHealthReport,
  TenantJiraTicket,
  ThresholdRule,
} from "@/types/tenant";
import { resolveDisplayName, makeNameResolver, fetchCustomerNames } from "@/lib/tenant-mapping";
import { extractionLogStats } from "@/lib/tenant-logs";
import { connectorDetailUrl, tenantHealthDashboardUrl } from "@/lib/tenant-grafana-links";

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

/**
 * PURE. Composite 0-100 health primitive. Start at 100, deduct for firing alerts
 * (critical heavier than warning) and integrations with extraction errors.
 * Clamped to [0, 100]. Higher = healthier. Shared by the tenant detail and fleet.
 */
export function scoreFromSignals(
  criticalAlerts: number,
  warningAlerts: number,
  erroredIntegrations: number,
): number {
  const score = 100 - 15 * criticalAlerts - 6 * warningAlerts - 8 * erroredIntegrations;
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function computeHealthScore(
  integrations: IntegrationHealth[],
  alerts: TenantAlert[],
): number {
  const firing = alerts.filter((a) => a.state === "firing");
  return scoreFromSignals(
    firing.filter((a) => a.severity === "critical").length,
    firing.filter((a) => a.severity === "warning").length,
    integrations.filter((i) => i.extractionErrors > 0).length,
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
  /** Per-tenant extraction error totals. */
  errorsByTenant: Map<string, number>;
  /** Per-tenant alerts. */
  alertsByTenant: Map<string, TenantAlert[]>;
}

/**
 * PURE. Build the fleet summary rows from aggregate (by-tenant) inputs. Universe
 * is the union of tenants seen in metrics + alerts. Sorted worst-health first,
 * then most active alerts, then name.
 */
export function buildFleetSummaries(
  inputs: FleetInputs,
  resolveName: (slug: string) => string = (s) => resolveDisplayName(s),
): FleetTenantSummary[] {
  const extractionsByTenant = new Map<string, number>();
  const integrationsByTenant = new Map<string, Set<string>>();
  for (const r of inputs.extractionRows) {
    extractionsByTenant.set(r.tenant, (extractionsByTenant.get(r.tenant) ?? 0) + r.value);
    const set = integrationsByTenant.get(r.tenant) ?? new Set<string>();
    set.add(r.agent);
    integrationsByTenant.set(r.tenant, set);
  }

  const tenants = new Set<string>([
    ...extractionsByTenant.keys(),
    ...inputs.errorsByTenant.keys(),
    ...inputs.alertsByTenant.keys(),
  ]);

  const rankSev: Record<Severity, number> = { critical: 0, warning: 1, ok: 2 };
  const rows: FleetTenantSummary[] = [...tenants].map((tenant) => {
    const alerts = inputs.alertsByTenant.get(tenant) ?? [];
    const firing = alerts.filter((a) => a.state === "firing");
    const criticalAlerts = firing.filter((a) => a.severity === "critical").length;
    const warningAlerts = firing.filter((a) => a.severity === "warning").length;
    const extractionErrors = Math.round(inputs.errorsByTenant.get(tenant) ?? 0);
    const worstAlert = [...firing].sort((a, b) => rankSev[a.severity] - rankSev[b.severity])[0];
    const topIssue = worstAlert
      ? alertIssueLine(worstAlert)
      : extractionErrors > 0
        ? `${extractionErrors} extraction error${extractionErrors === 1 ? "" : "s"}`
        : null;
    return {
      tenant,
      displayName: resolveName(tenant),
      extractions: Math.round(extractionsByTenant.get(tenant) ?? 0),
      extractionErrors,
      integrations: integrationsByTenant.get(tenant)?.size ?? 0,
      activeAlerts: firing.length,
      criticalAlerts,
      warningAlerts,
      healthScore: scoreFromSignals(criticalAlerts, warningAlerts, extractionErrors > 0 ? 1 : 0),
      severity: worstFiringSeverity(alerts),
      topIssue,
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
  /** Top error signatures per integration. */
  topErrorsByType: Map<string, ErrorSignature[]>;
  /** Builds the per-connector drill-down URL for an integration (null when unconfigured). */
  connectorUrl: (integration: string) => string | null;
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
    const topErrors = inputs.topErrorsByType.get(integration) ?? [];
    return {
      integration,
      providers,
      extractionErrors,
      parseAvgMs,
      parseTasks,
      outdated,
      topErrors,
      connectorUrl: inputs.connectorUrl(integration),
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
  try {
    const [ext, err, dur, tasks, writes, dsCount, outdated] = await Promise.all([
      queryInstant(`sum by (agent_type) (increase(veza_platform_extraction_total${sel}[${w}]))`),
      queryInstant(`sum by (agent_type) (increase(veza_platform_extraction_errors_total${sel}[${w}]))`),
      queryInstant(`sum by (agent_type) (increase(veza_platform_parser_task_duration_ms_total${sel}[${w}]))`),
      queryInstant(`sum by (agent_type) (increase(veza_platform_parser_task_total${sel}[${w}]))`),
      queryInstant(`sum by (entity_type, operation) (increase(veza_platform_parser_neo4j_writes_total${sel}[${w}]))`),
      // datasource_count has duplicate series per pod — max() dedupes.
      queryInstant(`max(cookie_platform_datasource_count${sel})`),
      // outdated datasources = extraction lag; agent_type label is UPPERCASE here.
      queryInstant(`sum by (agent_type) (veza_platform_datasources_flagged_outdated_total${sel})`),
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
  let topErrorsByType = new Map<string, ErrorSignature[]>();
  let errorTimeline: TenantHealthReport["errorTimeline"] = [];
  try {
    const logs = await extractionLogStats(tenant, inventory, windowHours);
    if (logs.dsUid) {
      providers = logs.providersByType;
      totalProviders = logs.totalProviders;
      hasProviderData = true;
      if (logs.errorByType.size > 0) extractionErrors = logs.errorByType;
      topErrorsByType = logs.topErrorsByType;
      errorTimeline = logs.errorTimeline;
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
    topErrorsByType,
    connectorUrl: (integration) => connectorDetailUrl(grafanaBase, tenant, integration),
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

  return {
    tenant,
    displayName,
    generatedAt: new Date().toISOString(),
    windowHours,
    integrations,
    graphWrites,
    errorTimeline,
    healthDashboardUrl: tenantHealthDashboardUrl(grafanaBase),
    alerts,
    errorClassification: classifyErrors(alerts),
    jiraTickets,
    healthScore: computeHealthScore(integrations, alerts),
    topIssues: buildTopIssues(integrations, alerts),
    totals: {
      integrations: integrations.length,
      providers: totalProviders,
      datasources,
      extractionErrors: Math.round(totalErrors),
      activeAlerts: alerts.filter((a) => a.state === "firing").length,
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
  let errorsByTenant = new Map<string, number>();
  try {
    const [ext, err] = await Promise.all([
      queryInstant(`sum by (tenant_id, agent_type) (increase(veza_platform_extraction_total[${w}]))`),
      queryInstant(`sum by (tenant_id) (increase(veza_platform_extraction_errors_total[${w}]))`),
    ]);
    extractionRows = ext
      .filter((r) => r.metric.tenant_id)
      .map((r) => ({ tenant: r.metric.tenant_id, agent: r.metric.agent_type ?? "?", value: r.value }));
    for (const r of err) if (r.metric.tenant_id) errorsByTenant.set(r.metric.tenant_id, r.value);
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
  const tenants = buildFleetSummaries(
    { extractionRows, errorsByTenant, alertsByTenant },
    makeNameResolver(customers),
  );
  return {
    generatedAt: new Date().toISOString(),
    windowHours,
    tenants,
    totals: {
      tenants: tenants.length,
      unhealthy: tenants.filter((t) => t.healthScore < 80).length,
      activeAlerts: tenants.reduce((n, t) => n + t.activeAlerts, 0),
    },
    sources,
  };
}

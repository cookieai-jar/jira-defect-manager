import { queryInstant, fetchActiveAlerts, parseTenantAlerts } from "@/lib/grafana";
import { searchIssues } from "@/lib/jira";
import { DEFAULT_THRESHOLDS, evaluateMetrics } from "@/lib/tenant-thresholds";
import type {
  GraphWrite,
  IntegrationHealth,
  IntegrationMetrics,
  Severity,
  TenantAlert,
  TenantHealthReport,
  TenantJiraTicket,
  ThresholdRule,
} from "@/types/tenant";

/**
 * Per-tenant health report assembly. Grafana is the spine (metrics + alerts),
 * JIRA joins via the Customer field. Heavy lifting is numeric (done here in
 * code); the model is not involved. Pure helpers are unit-tested; buildTenantReport
 * is exercised by a live smoke test.
 */

/**
 * Grafana `tenant_id` is a slug (e.g. "bcgprod"); JIRA's Customer field uses a
 * display name (e.g. "BCG"). They don't match directly. This override map is the
 * source of truth; unknown slugs fall back to a best-effort prettified guess.
 */
export const TENANT_NAME_OVERRIDES: Record<string, string> = {
  bcgprod: "BCG",
};

/** Best-effort display name for a tenant slug (override map wins). */
export function normalizeTenantDisplayName(slug: string): string {
  const o = TENANT_NAME_OVERRIDES[slug];
  if (o) return o;
  // Fallback: strip common env suffixes, split on separators, title-case.
  const base = slug.replace(/[-_](prod|staging|stg|dev|test|cp)$/i, "");
  return base
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

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
 * PURE. Composite 0-100 health score. Heuristic: start at 100 and deduct for
 * firing alerts (critical heavier than warning) and integrations with extraction
 * errors. Clamped to [0, 100]. Higher = healthier.
 */
export function computeHealthScore(
  integrations: IntegrationHealth[],
  alerts: TenantAlert[],
): number {
  let score = 100;
  for (const a of alerts) {
    if (a.state !== "firing") continue;
    if (a.severity === "critical") score -= 15;
    else if (a.severity === "warning") score -= 6;
  }
  score -= 8 * integrations.filter((i) => i.extractionErrors > 0).length;
  return Math.max(0, Math.min(100, Math.round(score)));
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
  extractions: Map<string, number>;
  extractionErrors: Map<string, number>;
  parseDurationMs: Map<string, number>;
  parseTasks: Map<string, number>;
  alertsByIntegration: Map<string, TenantAlert[]>;
}

/**
 * PURE. Combine the per-agent_type metric maps + grouped alerts into
 * IntegrationHealth[]. Inventory = base connectors (extraction agent_types plus
 * non-CSC parse agent_types); CSC pair series (containing "-") are excluded as
 * relationship-parse, not integrations. Sorted by severity then extraction volume.
 */
export function buildIntegrationHealth(
  inputs: IntegrationInputs,
  rules: ThresholdRule[] = DEFAULT_THRESHOLDS,
): IntegrationHealth[] {
  const names = new Set<string>(inputs.extractions.keys());
  for (const k of inputs.parseTasks.keys()) if (!k.includes("-")) names.add(k);

  const rankSev: Record<Severity, number> = { critical: 0, warning: 1, ok: 2 };
  const rows: IntegrationHealth[] = [...names].map((integration) => {
    // Prometheus increase() extrapolates to fractional values; round for display.
    const extractions = Math.round(inputs.extractions.get(integration) ?? 0);
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
    return { integration, extractions, extractionErrors, parseAvgMs, parseTasks, alerts, breaches, severity };
  });

  return rows.sort((a, b) => {
    const s = rankSev[a.severity] - rankSev[b.severity];
    return s !== 0 ? s : b.extractions - a.extractions;
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
  const displayName = normalizeTenantDisplayName(tenant);

  const sources = { grafanaMetrics: false, grafanaAlerts: false, jira: false, loki: false };

  // --- Grafana metrics (instant, windowed increase) ---
  let extractions = new Map<string, number>();
  let extractionErrors = new Map<string, number>();
  let parseDurationMs = new Map<string, number>();
  let parseTasks = new Map<string, number>();
  let graphWrites: GraphWrite[] = [];
  try {
    const [ext, err, dur, tasks, writes] = await Promise.all([
      queryInstant(`sum by (agent_type) (increase(veza_platform_extraction_total${sel}[${w}]))`),
      queryInstant(`sum by (agent_type) (increase(veza_platform_extraction_errors_total${sel}[${w}]))`),
      queryInstant(`sum by (agent_type) (increase(veza_platform_parser_task_duration_ms_total${sel}[${w}]))`),
      queryInstant(`sum by (agent_type) (increase(veza_platform_parser_task_total${sel}[${w}]))`),
      queryInstant(`sum by (entity_type, operation) (increase(veza_platform_parser_neo4j_writes_total${sel}[${w}]))`),
    ]);
    extractions = byLabel(ext, "agent_type");
    extractionErrors = byLabel(err, "agent_type");
    parseDurationMs = byLabel(dur, "agent_type");
    parseTasks = byLabel(tasks, "agent_type");
    graphWrites = writes
      .map((r) => ({ entityType: r.metric.entity_type ?? "?", operation: r.metric.operation ?? "?", count: Math.round(r.value) }))
      .sort((a, b) => b.count - a.count);
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

  const integrations = buildIntegrationHealth({
    extractions,
    extractionErrors,
    parseDurationMs,
    parseTasks,
    alertsByIntegration,
  });

  // --- JIRA tickets (Customer field join) ---
  let jiraTickets: TenantJiraTicket[] = [];
  try {
    const issues = await searchIssues(jiraCustomerJql(displayName), opts.jiraLimit ?? 50);
    jiraTickets = issues.map((i) => ({ key: i.key, summary: i.summary, status: i.status, url: i.url }));
    sources.jira = true;
  } catch (e) {
    console.warn(`[tenant-health] JIRA query failed for ${tenant}:`, e instanceof Error ? e.message : e);
  }

  const totalExtractions = [...extractions.values()].reduce((n, v) => n + v, 0);
  const totalErrors = [...extractionErrors.values()].reduce((n, v) => n + v, 0);

  return {
    tenant,
    displayName,
    generatedAt: new Date().toISOString(),
    windowHours,
    integrations,
    graphWrites,
    alerts,
    errorClassification: classifyErrors(alerts),
    jiraTickets,
    healthScore: computeHealthScore(integrations, alerts),
    topIssues: buildTopIssues(integrations, alerts),
    totals: {
      integrations: integrations.length,
      extractions: Math.round(totalExtractions),
      extractionErrors: Math.round(totalErrors),
      activeAlerts: alerts.filter((a) => a.state === "firing").length,
    },
    sources,
  };
}

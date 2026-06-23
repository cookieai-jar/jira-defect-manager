import type { MetricTrendPoint, Severity, TenantAlert } from "@/types/tenant";

interface GrafanaEnv {
  url: string;
  token: string;
  /** Prometheus datasource UID, when configured. */
  promUid: string | undefined;
}

function env(): GrafanaEnv {
  const url = process.env.GRAFANA_URL?.replace(/\/$/, "");
  const token = process.env.GRAFANA_TOKEN;
  if (!url || !token) {
    throw new Error(
      "Missing Grafana credentials. Set GRAFANA_URL, GRAFANA_TOKEN (and optionally GRAFANA_PROM_DATASOURCE_UID) in .env.local",
    );
  }
  return { url, token, promUid: process.env.GRAFANA_PROM_DATASOURCE_UID || undefined };
}

/**
 * The Prometheus API base path through Grafana. When a datasource UID is
 * configured we proxy through Grafana's datasource proxy; otherwise we assume a
 * direct Prometheus proxy mount. Kept in one place so both query functions and
 * the spike scripts agree on the path.
 */
function promBase({ url, promUid }: GrafanaEnv): string {
  return promUid
    ? `${url}/api/datasources/proxy/uid/${promUid}/api/v1`
    : `${url}/api/v1`;
}

async function grafanaFetch<T>(fullUrl: string, e: GrafanaEnv): Promise<T> {
  const res = await fetch(fullUrl, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${e.token}`,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Grafana ${res.status} on ${fullUrl}: ${text.slice(0, 500)}`);
  }
  return (await res.json()) as T;
}

export interface PromInstantSample {
  metric: Record<string, string>;
  value: number;
  /** Unix seconds. */
  t: number;
}

export type PromInstantResult = PromInstantSample[];

export interface PromMatrixSeries {
  metric: Record<string, string>;
  points: MetricTrendPoint[];
}

export type PromMatrixResult = PromMatrixSeries[];

/** Run a Prometheus instant query. Thin wrapper; parsing lives in parsePromInstant. */
export async function queryInstant(promql: string): Promise<PromInstantResult> {
  const e = env();
  const url = `${promBase(e)}/query?query=${encodeURIComponent(promql)}`;
  const json = await grafanaFetch<unknown>(url, e);
  return parsePromInstant(json);
}

/** Run a Prometheus range query. Thin wrapper; parsing lives in parsePromMatrix. */
export async function queryRange(
  promql: string,
  startSec: number,
  endSec: number,
  stepSec: number,
): Promise<PromMatrixResult> {
  const e = env();
  const params = new URLSearchParams({
    query: promql,
    start: String(startSec),
    end: String(endSec),
    step: String(stepSec),
  });
  const url = `${promBase(e)}/query_range?${params.toString()}`;
  const json = await grafanaFetch<unknown>(url, e);
  return parsePromMatrix(json);
}

/** Coerce a Prometheus string-encoded sample value to number; NaN if unparseable. */
function toNumber(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") return Number(raw);
  return NaN;
}

/**
 * PURE. Parse a Prometheus instant query response:
 *   { data: { result: [{ metric: {}, value: [ts, "val"] }] } }
 * Tolerates missing data/result, malformed value tuples, and NaN values
 * (samples with non-finite values are dropped).
 */
export function parsePromInstant(json: unknown): PromInstantResult {
  const result = (json as { data?: { result?: unknown } })?.data?.result;
  if (!Array.isArray(result)) return [];
  const out: PromInstantResult = [];
  for (const r of result) {
    const row = r as { metric?: Record<string, string>; value?: unknown };
    const value = row?.value;
    if (!Array.isArray(value) || value.length < 2) continue;
    const t = toNumber(value[0]);
    const v = toNumber(value[1]);
    if (!Number.isFinite(v)) continue;
    out.push({
      metric: row.metric && typeof row.metric === "object" ? row.metric : {},
      value: v,
      t,
    });
  }
  return out;
}

/**
 * PURE. Parse a Prometheus range query response:
 *   { data: { result: [{ metric: {}, values: [[ts, "val"], ...] }] } }
 * into series of MetricTrendPoint. Unix-second timestamps are converted to ISO
 * strings; NaN/non-finite sample values are dropped.
 */
export function parsePromMatrix(json: unknown): PromMatrixResult {
  const result = (json as { data?: { result?: unknown } })?.data?.result;
  if (!Array.isArray(result)) return [];
  const out: PromMatrixResult = [];
  for (const r of result) {
    const row = r as { metric?: Record<string, string>; values?: unknown };
    const values = Array.isArray(row?.values) ? row.values : [];
    const points: MetricTrendPoint[] = [];
    for (const pair of values) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const ts = toNumber(pair[0]);
      const v = toNumber(pair[1]);
      if (!Number.isFinite(v) || !Number.isFinite(ts)) continue;
      points.push({ t: new Date(ts * 1000).toISOString(), value: v });
    }
    out.push({
      metric: row.metric && typeof row.metric === "object" ? row.metric : {},
      points,
    });
  }
  return out;
}

/** A Loki datasource we can query for tenant logs. */
export interface LokiDatasource {
  uid: string;
  name: string;
}

/**
 * List queryable Loki datasources, excluding the special-purpose ones
 * (alert-state-history, usage-insights, cardinality) that don't hold app logs.
 * Tenant data-plane logs are spread across these by hosting region.
 */
export async function listLokiDatasources(): Promise<LokiDatasource[]> {
  const e = env();
  const all = await grafanaFetch<Array<{ uid: string; name: string; type: string }>>(
    `${e.url}/api/datasources`,
    e,
  );
  return all
    .filter((d) => d.type === "loki" && !/alert-state-history|usage-insights|cardinality/i.test(d.name))
    .map((d) => ({ uid: d.uid, name: d.name }));
}

function lokiBase(e: GrafanaEnv, uid: string): string {
  return `${e.url}/api/datasources/proxy/uid/${uid}/loki/api/v1`;
}

/**
 * Run a Loki metric query (e.g. count_over_time/sum) as an instant query. The
 * response shape matches Prometheus instant, so parsePromInstant handles it.
 */
export async function lokiCountQuery(uid: string, logql: string, now = Date.now()): Promise<PromInstantResult> {
  const e = env();
  const url = `${lokiBase(e, uid)}/query?query=${encodeURIComponent(logql)}&time=${now}000000`;
  return parsePromInstant(await grafanaFetch<unknown>(url, e));
}

/** True when a Loki stream selector returns at least one line in the last `hours`. */
export async function lokiStreamExists(uid: string, selector: string, hours = 6, now = Date.now()): Promise<boolean> {
  const e = env();
  const end = `${now}000000`;
  const start = `${now - hours * 3600 * 1000}000000`;
  const url = `${lokiBase(e, uid)}/query_range?query=${encodeURIComponent(selector)}&start=${start}&end=${end}&limit=1&direction=backward`;
  const r = await grafanaFetch<{ data?: { result?: unknown[] } }>(url, e);
  return Array.isArray(r?.data?.result) && r.data.result.length > 0;
}

/**
 * Fetch all currently-active Grafana-managed alerts (Alertmanager v2). Thin;
 * filtering/shaping lives in parseTenantAlerts.
 */
export async function fetchActiveAlerts(): Promise<unknown> {
  const e = env();
  return grafanaFetch<unknown>(`${e.url}/api/alertmanager/grafana/api/v2/alerts`, e);
}

/** Map a Grafana `severity` label to our Severity. Non-critical/warning (info, …) => "ok". */
function mapSeverity(raw: string | undefined): Severity {
  if (raw === "critical") return "critical";
  if (raw === "warning") return "warning";
  return "ok";
}

function alertKind(name: string): TenantAlert["kind"] {
  if (/parse/i.test(name)) return "parse";
  if (/extract/i.test(name)) return "extraction";
  return "other";
}

/**
 * PURE. The tenant an alert belongs to: the `tenant_id` label, else derived from
 * the `<tenant>-cp` k8s namespace, else null (infra alert with no tenant).
 */
export function alertTenantId(labels: Record<string, string>): string | null {
  if (labels.tenant_id) return labels.tenant_id;
  if (labels.namespace?.endsWith("-cp")) return labels.namespace.slice(0, -3);
  return null;
}

/** Shape one Alertmanager v2 alert into a TenantAlert (no filtering). */
function shapeAlert(a: unknown): TenantAlert {
  const labels = (a as { labels?: Record<string, string> })?.labels ?? {};
  const status = (a as { status?: { state?: string } })?.status?.state;
  const name = labels.alertname ?? "(unnamed)";
  return {
    integration: labels.agent_type || null,
    kind: alertKind(name),
    name,
    state: status === "suppressed" ? "resolved" : "firing",
    severity: mapSeverity(labels.severity),
    reason: labels.error_reason || labels.stage || null,
    firedAt: (a as { startsAt?: string })?.startsAt ?? null,
    source: "grafana",
    url: (a as { generatorURL?: string })?.generatorURL || null,
  };
}

/**
 * PURE. Filter the Alertmanager v2 alert array to one tenant and shape into
 * TenantAlert[]. A tenant matches when `tenant_id === tenant` OR the alert's
 * `<tenant>-cp` namespace maps to it.
 */
export function parseTenantAlerts(json: unknown, tenant: string): TenantAlert[] {
  if (!Array.isArray(json)) return [];
  return json
    .filter((a) => alertTenantId((a as { labels?: Record<string, string> })?.labels ?? {}) === tenant)
    .map(shapeAlert);
}

/** PURE. Group every tenant-attributable alert by tenant id. Infra alerts (no tenant) are dropped. */
export function parseAlertsByTenant(json: unknown): Map<string, TenantAlert[]> {
  const out = new Map<string, TenantAlert[]>();
  if (!Array.isArray(json)) return out;
  for (const a of json) {
    const t = alertTenantId((a as { labels?: Record<string, string> })?.labels ?? {});
    if (!t) continue;
    const list = out.get(t) ?? [];
    list.push(shapeAlert(a));
    out.set(t, list);
  }
  return out;
}

/**
 * PURE. Given parsed series (instant or matrix), return the sorted, de-duplicated
 * distinct values of a label key — used to discover tenants / integrations from
 * metric labels.
 */
export function distinctLabelValues(
  series: Array<{ metric: Record<string, string> }>,
  label: string,
): string[] {
  const set = new Set<string>();
  for (const s of series) {
    const v = s?.metric?.[label];
    if (typeof v === "string" && v.length > 0) set.add(v);
  }
  return [...set].sort();
}

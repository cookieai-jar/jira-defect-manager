import {
  listLokiDatasources,
  lokiStreamExists,
  lokiCountQuery,
  lokiRangeQuery,
  lokiLogLines,
} from "@/lib/grafana";
import type { ErrorSignature, ErrorTimelinePoint } from "@/types/tenant";

/**
 * Log-based extraction counts. The extractor worker logs a START / FINISH line
 * per data-source extraction (extractor_worker.go); counting FINISH lines is the
 * truest count of actual extractions — more accurate than the
 * `veza_platform_extraction_total` ("successful extractions") metric.
 *
 * Wrinkle: tenant data-plane logs are REGIONAL — each tenant's logs live in one
 * regional Loki datasource (namespace `<tenant>-dp`), while metrics are central.
 * So we first discover which datasource holds the tenant, then count there.
 * Pure query-builders are unit-tested; the network bits are cached.
 */

const FINISH_LINE = "FINISH - Extracting data source";
const START_LINE = "START - Extracting data source";
const ERROR_LINE = "Error extracting data sources";

/** Stream selector for a tenant's data-plane logs. */
export function tenantDpSelector(tenant: string): string {
  return `{namespace="${tenant}-dp"}`;
}

/** Probe selector: any extraction line in the tenant's data plane. */
export function extractionProbeSelector(tenant: string): string {
  return `${tenantDpSelector(tenant)} |= \`${START_LINE.replace(/^START - /, "")}\``;
}

/** LogQL: count a given extraction line over the window, grouped by datasource_type. */
function countByTypeQuery(tenant: string, line: string, windowHours: number): string {
  return `sum by (datasource_type) (count_over_time(${tenantDpSelector(tenant)} |= \`${line}\` | json [${windowHours}h]))`;
}

export function errorByTypeQuery(tenant: string, windowHours = 24): string {
  return countByTypeQuery(tenant, ERROR_LINE, windowHours);
}

/** LogQL metric: tenant-wide extraction errors per `bucket` (for the timeline range query). */
export function errorTimelineQuery(tenant: string, bucket = "1h"): string {
  return `sum(count_over_time(${tenantDpSelector(tenant)} |= \`${ERROR_LINE}\` [${bucket}]))`;
}

/** LogQL: recent extraction-error log lines (parsed) for signature sampling. */
export function errorSamplesQuery(tenant: string): string {
  return `${tenantDpSelector(tenant)} |= \`${ERROR_LINE}\` | json`;
}

/**
 * PURE. Normalize an extractor error message into a stable signature by dropping
 * the per-datasource "[type - uuid]" prefix and any ids, so the same failure
 * mode across many datasources collapses to one signature.
 */
export function normalizeErrorSignature(msg: string): string {
  return msg
    .replace(/\[[^\]]*\]/g, "") // drop "[azure_sql - 019d…]" brackets
    .replace(/[0-9a-f]{8}-[0-9a-f-]{20,}/gi, "<id>") // uuids
    .replace(/\b[0-9a-f]{16,}\b/gi, "<id>") // long hex ids
    .replace(/\b\d{5,}\b/g, "<n>") // long numbers
    .replace(/\s+/g, " ")
    .replace(/^(?:extract[:\s]+)+/i, "") // drop the leading "extract:"/"extract :" verb(s)
    .replace(/^[\s:]+/, "")
    .trim()
    .slice(0, 180);
}

/**
 * PURE. Group parsed error log lines by datasource_type and tally normalized
 * signatures, returning the top `perType` signatures per integration.
 */
export function topErrorsByType(
  lines: string[],
  perType = 2,
): Map<string, ErrorSignature[]> {
  // type -> signature -> count
  const acc = new Map<string, Map<string, number>>();
  for (const raw of lines) {
    let j: { datasource_type?: string; error?: string };
    try {
      j = JSON.parse(raw);
    } catch {
      continue;
    }
    const type = j.datasource_type;
    const err = j.error;
    if (!type || !err) continue;
    const sig = normalizeErrorSignature(String(err));
    if (!sig) continue;
    if (!acc.has(type)) acc.set(type, new Map());
    const m = acc.get(type)!;
    m.set(sig, (m.get(sig) ?? 0) + 1);
  }
  const out = new Map<string, ErrorSignature[]>();
  for (const [type, m] of acc) {
    const sigs = [...m.entries()]
      .map(([signature, count]) => ({ signature, count }))
      .sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature))
      .slice(0, perType);
    out.set(type, sigs);
  }
  return out;
}

/**
 * Provider window is fixed and short (1h). Counting DISTINCT providers requires
 * grouping by provider_id; doing it for ALL integrations at once
 * (count by (datasource_type, provider_id) ...) blows Loki's 2000-series cap on
 * big tenants, so we instead fan out ONE query per integration type (each is
 * low-cardinality: providers for a single type). Provider presence is stable
 * hour-to-hour, so 1h is a faithful "providers actively extracting" snapshot.
 */
export const PROVIDER_WINDOW_HOURS = 1;

/** LogQL: distinct providers for ONE integration type over the provider window. */
export function providersForTypeQuery(tenant: string, datasourceType: string, windowHours = PROVIDER_WINDOW_HOURS): string {
  return `count(count by (provider_id) (count_over_time(${tenantDpSelector(tenant)} |= \`${FINISH_LINE}\` | json | datasource_type=\`${datasourceType}\` [${windowHours}h])))`;
}

/** LogQL: distinct providers tenant-wide over the provider window. */
export function totalProvidersQuery(tenant: string, windowHours = PROVIDER_WINDOW_HOURS): string {
  return `count(count by (provider_id) (count_over_time(${tenantDpSelector(tenant)} |= \`${FINISH_LINE}\` | json [${windowHours}h])))`;
}

/** Run async `fn` over `items` with bounded concurrency, preserving order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// --- regional datasource discovery (cached) -----------------------------------

const _dsCache = new Map<string, string | null>();

/**
 * Find the Loki datasource uid that holds this tenant's data-plane extraction
 * logs, probing regional datasources in parallel. Cached per tenant (incl. a
 * null "not found" so we don't re-probe every load).
 */
export async function findTenantLogDatasource(tenant: string): Promise<string | null> {
  if (_dsCache.has(tenant)) return _dsCache.get(tenant) ?? null;
  let uid: string | null = null;
  try {
    const datasources = await listLokiDatasources();
    const probe = extractionProbeSelector(tenant);
    const hits = await Promise.all(
      datasources.map(async (d) => ((await lokiStreamExists(d.uid, probe).catch(() => false)) ? d.uid : null)),
    );
    uid = hits.find((u): u is string => u !== null) ?? null;
  } catch {
    uid = null;
  }
  _dsCache.set(tenant, uid);
  return uid;
}

/** Reset the discovery cache (tests). */
export function _clearLogDatasourceCache(): void {
  _dsCache.clear();
}

export interface ExtractionLogStats {
  dsUid: string | null;
  /** Distinct providers per integration (datasource_type) over the provider window. */
  providersByType: Map<string, number>;
  /** Distinct providers tenant-wide, or null when the grouped query was unavailable. */
  totalProviders: number | null;
  /** Extraction-error-line count per datasource_type over `windowHours`. */
  errorByType: Map<string, number>;
  /** Top error signatures per integration (datasource_type), from recent samples. */
  topErrorsByType: Map<string, ErrorSignature[]>;
  /** Tenant-wide extraction-error counts over time (hourly buckets). */
  errorTimeline: ErrorTimelinePoint[];
}

function toMap(result: Array<{ metric: Record<string, string>; value: number }>): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of result) {
    const k = r.metric.datasource_type;
    if (k) m.set(k, Math.round((m.get(k) ?? 0) + r.value));
  }
  return m;
}

/** Scalar value out of a Loki count() result (single series, no labels). */
function scalar(result: Array<{ value: number }>): number | null {
  return result.length > 0 ? Math.round(result[0].value) : null;
}

/**
 * Per-integration distinct-provider counts + extraction errors for a tenant,
 * from its regional Loki. Providers are fanned out one query per inventory type
 * (bounded concurrency) over a short window; errors use `windowHours`. Empty +
 * null dsUid when logs can't be located.
 */
export async function extractionLogStats(
  tenant: string,
  inventory: string[],
  windowHours = 24,
): Promise<ExtractionLogStats> {
  const dsUid = await findTenantLogDatasource(tenant);
  if (!dsUid) {
    return {
      dsUid: null,
      providersByType: new Map(),
      totalProviders: null,
      errorByType: new Map(),
      topErrorsByType: new Map(),
      errorTimeline: [],
    };
  }
  // Base integration types only (skip CSC pairs); fan out distinct-provider counts.
  const types = inventory.filter((t) => !t.includes("-"));
  const nowSec = Math.floor(Date.now() / 1000);
  const startSec = nowSec - windowHours * 3600;
  const [total, error, perType, samples, timeline] = await Promise.all([
    lokiCountQuery(dsUid, totalProvidersQuery(tenant)).catch(() => []),
    lokiCountQuery(dsUid, errorByTypeQuery(tenant, windowHours)).catch(() => []),
    mapLimit(types, 16, async (ty) => {
      const r = await lokiCountQuery(dsUid, providersForTypeQuery(tenant, ty)).catch(() => []);
      return [ty, scalar(r) ?? 0] as const;
    }),
    lokiLogLines(dsUid, errorSamplesQuery(tenant), startSec, nowSec, 300).catch(() => []),
    lokiRangeQuery(dsUid, errorTimelineQuery(tenant, "1h"), startSec, nowSec, 3600).catch(() => []),
  ]);
  const providersByType = new Map(perType.filter(([, n]) => n > 0));
  const errorTimeline: ErrorTimelinePoint[] =
    timeline[0]?.points.map((p) => ({ t: p.t, count: Math.round(p.value) })) ?? [];
  return {
    dsUid,
    providersByType,
    totalProviders: scalar(total),
    errorByType: toMap(error),
    topErrorsByType: topErrorsByType(samples),
    errorTimeline,
  };
}

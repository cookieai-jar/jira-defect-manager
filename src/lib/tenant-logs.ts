import { listLokiDatasources, lokiStreamExists, lokiCountQuery } from "@/lib/grafana";

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

export function finishByTypeQuery(tenant: string, windowHours = 24): string {
  return countByTypeQuery(tenant, FINISH_LINE, windowHours);
}
export function errorByTypeQuery(tenant: string, windowHours = 24): string {
  return countByTypeQuery(tenant, ERROR_LINE, windowHours);
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
  /** FINISH-line count per datasource_type (= integration). */
  finishByType: Map<string, number>;
  /** Error-line count per datasource_type. */
  errorByType: Map<string, number>;
}

function toMap(result: Array<{ metric: Record<string, string>; value: number }>): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of result) {
    const k = r.metric.datasource_type;
    if (k) m.set(k, Math.round((m.get(k) ?? 0) + r.value));
  }
  return m;
}

/**
 * Count actual extractions (FINISH lines) and extraction errors per integration
 * for a tenant, from its regional Loki. Returns empty maps + null dsUid when the
 * tenant's logs can't be located (caller falls back to the metric).
 */
export async function extractionLogStats(tenant: string, windowHours = 24): Promise<ExtractionLogStats> {
  const dsUid = await findTenantLogDatasource(tenant);
  if (!dsUid) return { dsUid: null, finishByType: new Map(), errorByType: new Map() };
  const [finish, error] = await Promise.all([
    lokiCountQuery(dsUid, finishByTypeQuery(tenant, windowHours)).catch(() => []),
    lokiCountQuery(dsUid, errorByTypeQuery(tenant, windowHours)).catch(() => []),
  ]);
  return { dsUid, finishByType: toMap(finish), errorByType: toMap(error) };
}

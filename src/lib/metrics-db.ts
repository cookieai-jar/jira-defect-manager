/**
 * Authoritative per-datasource health from the Grafana-managed "Metrics DB"
 * (Postgres). Its `datasources` table is current-state (one row per datasource)
 * and carries real sync/parse status, error reasons, timing, and an outdated
 * flag — the actionable per-datasource detail the metrics don't expose. The
 * visible row count also serves as the datasource total (it agrees with the
 * `cookie_platform_datasource_count` metric for the matching tenant).
 *
 * The DB tenant_id is USUALLY the Grafana slug ("bcgprod"), but some tenants are
 * keyed by a short/env-stripped id, so we try the raw slug first (exact, the
 * common case) then the normalized form, and reject a match that shares no
 * integrations with what Grafana reports for the tenant (collision guard).
 */
import { queryPostgres } from "./grafana";
import { isSafeIdentifier } from "./rca-core";
import { normalizeSlugForMatch } from "./tenant-mapping";
import type { DatasourceHealth, DatasourceRow } from "@/types/tenant";

/** UID of the "Metrics DB (General Access)" Postgres datasource (env-overridable). */
export function metricsDbUid(): string {
  return process.env.METRICS_DB_DATASOURCE_UID || "i3rp8HoVk";
}

/** Per-datasource detail is capped so a huge tenant can't bloat the payload. */
const PROBLEM_LIMIT = 200;

/** sync_status values that are NOT failures (success or in-flight). The rest —
 *  PERMISSION_DENIED, UNAVAILABLE, UNAUTHENTICATED, ERROR, DEADLINE_EXCEEDED… —
 *  all count as failing. */
const HEALTHY_SYNC = "('SUCCESS','EXTRACTION_PENDING','EXTRACTION_IN_PROGRESS')";

/** PURE. Coerce a Postgres count/bigint cell (number or string) to a number. */
function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** PURE. Epoch-ms bigint → seconds-of-age from `nowSec`; null when unset (0/null). */
function ageSec(v: unknown, nowSec: number): number | null {
  const ms = num(v);
  if (ms <= 0) return null;
  return Math.max(0, nowSec - Math.round(ms / 1000));
}

/** PURE. Shape a raw `datasources` row into a DatasourceRow. */
export function toDatasourceRow(r: Record<string, unknown>, nowSec: number): DatasourceRow {
  const s = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
  return {
    name: s(r.name),
    datasourceType: s(r.datasource_type),
    agentType: s(r.agent_type),
    syncStatus: s(r.sync_status) || "UNKNOWN",
    parseStatus: s(r.parse_status) || "UNKNOWN",
    syncError: r.sync_error_reason ? s(r.sync_error_reason) : null,
    lastSyncAgeSec: ageSec(r.synced_at_success, nowSec),
    outdated: Boolean(r.outdated),
  };
}

/** Map a Grafana tenant slug to candidate Metrics DB tenant_ids, RAW slug first
 *  (an exact match is unambiguous) then the env-suffix-stripped form
 *  ("bcgprod"→"bcg"). Only SQL-safe identifiers are returned. */
export function dbTenantCandidates(slug: string): string[] {
  const norm = normalizeSlugForMatch(slug);
  return [...new Set([slug, norm].filter((s) => s && isSafeIdentifier(s)))];
}

/** A safe `YYYY-MM-DD HH:MM:SS(.ffffff)` timestamp literal (server-derived; validated). */
function isSafeTimestamp(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s);
}

/** SQL `agent_type IN (...)` clause from the tenant's Grafana integrations, or null. */
function inventoryClause(inventory: string[]): string | null {
  const safe = [...new Set(inventory.filter(isSafeIdentifier))];
  return safe.length ? `agent_type IN (${safe.map((a) => `'${a}'`).join(",")})` : null;
}

/**
 * Fetch authoritative datasource health for a tenant from the Metrics DB.
 * Returns null when no candidate id resolves (graceful — callers fall back to
 * the metric count).
 *
 * Mapping safety: the DB keys tenants by a short id, not the Grafana slug, so we
 * resolve heuristically. To avoid surfacing a DIFFERENT customer's data on a
 * normalization collision, a resolved id is REJECTED unless its datasources
 * share at least one integration (agent_type) with what Grafana reports for this
 * tenant (when that inventory is known). Tenant id + snapshot literal are
 * validated before interpolation.
 */
export async function fetchTenantDatasourceHealth(
  slug: string,
  inventory: string[] = [],
  now: number = Date.now(),
): Promise<DatasourceHealth | null> {
  const uid = metricsDbUid();
  const nowSec = Math.floor(now / 1000);
  const invClause = inventoryClause(inventory);

  for (const t of dbTenantCandidates(slug)) {
    // t is validated to [a-zA-Z0-9_-], so it cannot break out of the quotes.
    // Resolve existence + the latest snapshot + a corroboration overlap in one cheap query.
    const resolve = await queryPostgres(
      uid,
      `SELECT count(*) total,
              count(*) FILTER (WHERE ${invClause ?? "true"}) overlap,
              to_char(max(snapshot_timestamp),'YYYY-MM-DD HH24:MI:SS.US') snap
       FROM datasources WHERE tenant_id = '${t}'`,
    );
    const total = num(resolve[0]?.total);
    if (total === 0) continue; // no data under this candidate id — try the next
    // Reject a wrong-tenant match: a real match shares ≥1 integration with Grafana.
    if (invClause && num(resolve[0]?.overlap) === 0) {
      console.warn(`[metrics-db] candidate '${t}' for slug '${slug}' shares no integrations with Grafana — skipping`);
      continue;
    }
    const snap = resolve[0]?.snap ? String(resolve[0].snap) : null;
    if (t !== slug) console.warn(`[metrics-db] slug '${slug}' resolved to DB tenant '${t}' (normalized)`);

    // Pin all detail queries to the one resolved snapshot (avoids skew across the
    // parallel queries if a new snapshot lands mid-flight).
    const snapClause = snap && isSafeTimestamp(snap) ? `snapshot_timestamp = '${snap}'` : "true";
    const sel = `tenant_id = '${t}' AND ${snapClause} AND NOT is_hidden`;
    const [summary, byStatus, errReasons, problems] = await Promise.all([
      queryPostgres(
        uid,
        `SELECT count(*) total,
                count(*) FILTER (WHERE sync_status NOT IN ${HEALTHY_SYNC}) failing,
                count(*) FILTER (WHERE parse_status='ERROR') parse_errors,
                count(*) FILTER (WHERE outdated) outdated
         FROM datasources WHERE ${sel}`,
      ),
      queryPostgres(uid, `SELECT sync_status status, count(*) c FROM datasources WHERE ${sel} GROUP BY sync_status ORDER BY c DESC`),
      queryPostgres(
        uid,
        `SELECT sync_error_reason reason, count(*) c FROM datasources WHERE ${sel} AND sync_status='ERROR' AND sync_error_reason IS NOT NULL GROUP BY sync_error_reason ORDER BY c DESC LIMIT 12`,
      ),
      queryPostgres(
        uid,
        // LIMIT+1 so we can tell "exactly the cap" from "truncated".
        `SELECT name, datasource_type, agent_type, sync_status, parse_status, sync_error_reason, synced_at_success, outdated
         FROM datasources WHERE ${sel} AND (sync_status NOT IN ${HEALTHY_SYNC} OR parse_status='ERROR' OR outdated)
         ORDER BY (sync_status NOT IN ${HEALTHY_SYNC}) DESC, (parse_status='ERROR') DESC, outdated DESC, name LIMIT ${PROBLEM_LIMIT + 1}`,
      ),
    ]);

    const problemRows = problems.slice(0, PROBLEM_LIMIT).map((r) => toDatasourceRow(r, nowSec));
    return {
      dbTenantId: t,
      total: num(summary[0]?.total),
      failing: num(summary[0]?.failing),
      parseErrors: num(summary[0]?.parse_errors),
      outdated: num(summary[0]?.outdated),
      byStatus: byStatus.map((r) => ({ status: String(r.status ?? "UNKNOWN"), count: num(r.c) })),
      topSyncErrors: errReasons.map((r) => ({ reason: String(r.reason ?? "UNKNOWN"), count: num(r.c) })),
      problems: problemRows,
      problemsTruncated: problems.length > PROBLEM_LIMIT,
      snapshotAt: snap,
    };
  }
  return null;
}

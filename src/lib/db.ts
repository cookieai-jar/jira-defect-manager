import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  JiraIssue,
  P0Customer,
  TriageReport,
  TicketAnalysis,
  Scope,
  PriorityDecision,
  Priority,
  PriorityChange,
} from "@/types/triage";
import type { IntegrationsAnalysis } from "@/types/integrations";
import type { ErrorRcaResult } from "@/types/tenant";

const DATA_DIR = join(process.cwd(), "data");
mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = join(DATA_DIR, "triage.db");

let _db: DatabaseSync | null = null;

function hasColumn(conn: DatabaseSync, table: string, column: string): boolean {
  const rows = conn.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

function tableExists(conn: DatabaseSync, table: string): boolean {
  const row = conn
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table);
  return !!row;
}

export function db(): DatabaseSync {
  if (_db) return _db;
  const conn = new DatabaseSync(DB_PATH);
  conn.exec("PRAGMA journal_mode = WAL");
  conn.exec("PRAGMA foreign_keys = ON");
  conn.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS p0_customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      jql_fragment TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_analyzed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS issues (
      key TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS analyses (
      issue_key TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (issue_key) REFERENCES issues(key) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data TEXT NOT NULL,
      generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at TEXT,
      status TEXT NOT NULL,
      issues_pulled INTEGER DEFAULT 0,
      issues_analyzed INTEGER DEFAULT 0,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS priority_decisions (
      issue_key TEXT PRIMARY KEY,
      decision TEXT NOT NULL,
      decided_at TEXT NOT NULL,
      decided_priority_change TEXT,
      decided_recommended_priority TEXT,
      decided_current_priority TEXT,
      decided_ticket_updated_at TEXT,
      revisit_flagged INTEGER NOT NULL DEFAULT 0,
      revisit_reason TEXT
    );

    -- Strategic Integrations dashboard: its own issue + report storage, kept
    -- separate from the triage-scope issues/reports tables because its
    -- analysis is a cross-ticket pattern report, not per-ticket triage.
    CREATE TABLE IF NOT EXISTS integration_issues (
      key TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS integration_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data TEXT NOT NULL,
      generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Tenant Health: append-only per-tenant health-score snapshots, recorded
    -- (throttled ~hourly) on each fleet computation. Powers trend sparklines +
    -- deltas. Pruned to a rolling window.
    CREATE TABLE IF NOT EXISTS health_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant TEXT NOT NULL,
      score INTEGER NOT NULL,
      ts TEXT NOT NULL
    );

    -- Tenant Health: tenants the user has starred to watch (manual watch-list,
    -- separate from the configured white-glove customers).
    CREATE TABLE IF NOT EXISTS starred_tenants (
      tenant TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Tenant Health: persisted root-cause analyses, one per (tenant, integration).
    -- Re-running an analysis upserts. The result JSON carries the signals
    -- fingerprint used to flag staleness against the live failure picture.
    CREATE TABLE IF NOT EXISTS rca_results (
      tenant TEXT NOT NULL,
      integration TEXT NOT NULL,
      data TEXT NOT NULL,
      generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (tenant, integration)
    );

    -- All Defects: daily historical distribution snapshots for the tile trends.
    -- One row per (day, group, key), e.g. (2026-07-13, "priority", "P1", 5).
    CREATE TABLE IF NOT EXISTS defect_snapshots (
      day TEXT NOT NULL,
      grp TEXT NOT NULL,
      k TEXT NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (day, grp, k)
    );
  `);

  // Migrate: add scope column to tables that need it. Existing rows default to 'eac'.
  for (const table of ["issues", "analyses", "reports", "p0_customers", "sync_runs"]) {
    if (tableExists(conn, table) && !hasColumn(conn, table, "scope")) {
      conn.exec(`ALTER TABLE ${table} ADD COLUMN scope TEXT NOT NULL DEFAULT 'eac'`);
    }
  }
  // Helpful indices
  conn.exec(`
    CREATE INDEX IF NOT EXISTS idx_issues_scope ON issues(scope);
    CREATE INDEX IF NOT EXISTS idx_analyses_scope ON analyses(scope);
    CREATE INDEX IF NOT EXISTS idx_reports_scope_id ON reports(scope, id DESC);
    CREATE INDEX IF NOT EXISTS idx_p0_scope ON p0_customers(scope);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_health_snapshots_tenant_ts ON health_snapshots(tenant, ts);
  `);

  _db = conn;
  return conn;
}

export function saveIssue(scope: Scope, issue: JiraIssue) {
  db().prepare(
    `INSERT INTO issues (key, data, synced_at, scope) VALUES (?, ?, CURRENT_TIMESTAMP, ?)
     ON CONFLICT(key) DO UPDATE SET data = excluded.data, synced_at = CURRENT_TIMESTAMP, scope = excluded.scope`,
  ).run(issue.key, JSON.stringify(issue), scope);
}

export function listIssues(scope: Scope): JiraIssue[] {
  const rows = db()
    .prepare(`SELECT data FROM issues WHERE scope = ? ORDER BY key`)
    .all(scope) as { data: string }[];
  return rows.map((r) => JSON.parse(r.data) as JiraIssue);
}

export function getIssue(key: string): JiraIssue | null {
  const row = db().prepare(`SELECT data FROM issues WHERE key = ?`).get(key) as
    | { data: string }
    | undefined;
  return row ? (JSON.parse(row.data) as JiraIssue) : null;
}

export function saveAnalysis(scope: Scope, a: TicketAnalysis) {
  db().prepare(
    `INSERT INTO analyses (issue_key, data, generated_at, scope) VALUES (?, ?, CURRENT_TIMESTAMP, ?)
     ON CONFLICT(issue_key) DO UPDATE SET data = excluded.data, generated_at = CURRENT_TIMESTAMP, scope = excluded.scope`,
  ).run(a.issueKey, JSON.stringify(a), scope);
}

export function listAnalyses(scope: Scope): TicketAnalysis[] {
  const rows = db()
    .prepare(`SELECT data FROM analyses WHERE scope = ?`)
    .all(scope) as { data: string }[];
  return rows.map((r) => JSON.parse(r.data) as TicketAnalysis);
}

export function getAnalysis(key: string): TicketAnalysis | null {
  const row = db().prepare(`SELECT data FROM analyses WHERE issue_key = ?`).get(key) as
    | { data: string }
    | undefined;
  return row ? (JSON.parse(row.data) as TicketAnalysis) : null;
}

export function saveReport(scope: Scope, report: TriageReport): number {
  const info = db()
    .prepare(`INSERT INTO reports (data, scope) VALUES (?, ?)`)
    .run(JSON.stringify(report), scope);
  return Number(info.lastInsertRowid);
}

export function latestReport(scope: Scope): TriageReport | null {
  const row = db()
    .prepare(`SELECT data FROM reports WHERE scope = ? ORDER BY id DESC LIMIT 1`)
    .get(scope) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as TriageReport) : null;
}

export function listP0(): P0Customer[] {
  const rows = db()
    .prepare(`SELECT * FROM p0_customers ORDER BY name`)
    .all() as Array<{
    id: string;
    name: string;
    jql_fragment: string;
    notes: string | null;
    created_at: string;
    last_analyzed_at: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    jqlFragment: r.jql_fragment,
    notes: r.notes,
    createdAt: r.created_at,
    lastAnalyzedAt: r.last_analyzed_at,
  }));
}

export function getP0(id: string): P0Customer | null {
  const row = db().prepare(`SELECT * FROM p0_customers WHERE id = ?`).get(id) as
    | {
        id: string;
        name: string;
        jql_fragment: string;
        notes: string | null;
        created_at: string;
        last_analyzed_at: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    jqlFragment: row.jql_fragment,
    notes: row.notes,
    createdAt: row.created_at,
    lastAnalyzedAt: row.last_analyzed_at,
  };
}

export function upsertP0(c: P0Customer) {
  db().prepare(
    `INSERT INTO p0_customers (id, name, jql_fragment, notes, created_at, last_analyzed_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       jql_fragment = excluded.jql_fragment,
       notes = excluded.notes,
       last_analyzed_at = excluded.last_analyzed_at`,
  ).run(c.id, c.name, c.jqlFragment, c.notes, c.createdAt, c.lastAnalyzedAt);
}

export function deleteP0(id: string) {
  db().prepare(`DELETE FROM p0_customers WHERE id = ?`).run(id);
}

export function getConfigValue(key: string): string | null {
  const row = db().prepare(`SELECT value FROM config WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function setConfigValue(key: string, value: string) {
  db().prepare(
    `INSERT INTO config (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
  ).run(key, value);
}

export function recordSyncStart(scope: Scope): number {
  const info = db()
    .prepare(`INSERT INTO sync_runs (status, scope) VALUES ('running', ?)`)
    .run(scope);
  return Number(info.lastInsertRowid);
}

export function recordSyncFinish(
  id: number,
  status: "success" | "error",
  pulled: number,
  analyzed: number,
  error: string | null = null,
) {
  db().prepare(
    `UPDATE sync_runs SET finished_at = CURRENT_TIMESTAMP, status = ?, issues_pulled = ?, issues_analyzed = ?, error = ? WHERE id = ?`,
  ).run(status, pulled, analyzed, error, id);
}

interface DecisionRow {
  issue_key: string;
  decision: string;
  decided_at: string;
  decided_priority_change: string | null;
  decided_recommended_priority: string | null;
  decided_current_priority: string | null;
  decided_ticket_updated_at: string | null;
  revisit_flagged: number;
  revisit_reason: string | null;
}

function rowToDecision(r: DecisionRow): PriorityDecision {
  return {
    issueKey: r.issue_key,
    decision: "ignore",
    decidedAt: r.decided_at,
    decidedPriorityChange: (r.decided_priority_change as PriorityChange | null) ?? null,
    decidedRecommendedPriority: (r.decided_recommended_priority as Priority | null) ?? null,
    decidedCurrentPriority: (r.decided_current_priority as Priority | null) ?? null,
    decidedTicketUpdatedAt: r.decided_ticket_updated_at,
    revisitFlagged: r.revisit_flagged === 1,
    revisitReason: r.revisit_reason,
  };
}

export function listDecisions(): PriorityDecision[] {
  const rows = db()
    .prepare(`SELECT * FROM priority_decisions ORDER BY decided_at DESC`)
    .all() as unknown as DecisionRow[];
  return rows.map(rowToDecision);
}

export function getDecision(issueKey: string): PriorityDecision | null {
  const row = db()
    .prepare(`SELECT * FROM priority_decisions WHERE issue_key = ?`)
    .get(issueKey) as unknown as DecisionRow | undefined;
  return row ? rowToDecision(row) : null;
}

export function upsertDecision(d: PriorityDecision) {
  db()
    .prepare(
      `INSERT INTO priority_decisions (
        issue_key, decision, decided_at, decided_priority_change,
        decided_recommended_priority, decided_current_priority,
        decided_ticket_updated_at, revisit_flagged, revisit_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(issue_key) DO UPDATE SET
        decision = excluded.decision,
        decided_at = excluded.decided_at,
        decided_priority_change = excluded.decided_priority_change,
        decided_recommended_priority = excluded.decided_recommended_priority,
        decided_current_priority = excluded.decided_current_priority,
        decided_ticket_updated_at = excluded.decided_ticket_updated_at,
        revisit_flagged = excluded.revisit_flagged,
        revisit_reason = excluded.revisit_reason`,
    )
    .run(
      d.issueKey,
      d.decision,
      d.decidedAt,
      d.decidedPriorityChange,
      d.decidedRecommendedPriority,
      d.decidedCurrentPriority,
      d.decidedTicketUpdatedAt,
      d.revisitFlagged ? 1 : 0,
      d.revisitReason,
    );
}

export function deleteDecision(issueKey: string) {
  db().prepare(`DELETE FROM priority_decisions WHERE issue_key = ?`).run(issueKey);
}

export function clearRevisitFlag(issueKey: string) {
  db()
    .prepare(
      `UPDATE priority_decisions SET revisit_flagged = 0, revisit_reason = NULL WHERE issue_key = ?`,
    )
    .run(issueKey);
}

export function latestSyncRun(scope: Scope) {
  return db()
    .prepare(`SELECT * FROM sync_runs WHERE scope = ? ORDER BY id DESC LIMIT 1`)
    .get(scope);
}

// --- Strategic Integrations storage -----------------------------------------

/** Replace the stored integration issue set with the freshly synced one. */
export function replaceIntegrationIssues(issues: JiraIssue[]) {
  const conn = db();
  conn.exec("DELETE FROM integration_issues");
  const stmt = conn.prepare(
    `INSERT INTO integration_issues (key, data, synced_at) VALUES (?, ?, CURRENT_TIMESTAMP)`,
  );
  for (const issue of issues) stmt.run(issue.key, JSON.stringify(issue));
}

export function listIntegrationIssues(): JiraIssue[] {
  const rows = db()
    .prepare(`SELECT data FROM integration_issues ORDER BY key`)
    .all() as { data: string }[];
  return rows.map((r) => JSON.parse(r.data) as JiraIssue);
}

export function getIntegrationIssue(key: string): JiraIssue | null {
  const row = db()
    .prepare(`SELECT data FROM integration_issues WHERE key = ?`)
    .get(key) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as JiraIssue) : null;
}

export function saveIntegrationsReport(report: IntegrationsAnalysis): number {
  const info = db()
    .prepare(`INSERT INTO integration_reports (data) VALUES (?)`)
    .run(JSON.stringify(report));
  return Number(info.lastInsertRowid);
}

export function latestIntegrationsReport(): IntegrationsAnalysis | null {
  const row = db()
    .prepare(`SELECT data FROM integration_reports ORDER BY id DESC LIMIT 1`)
    .get() as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as IntegrationsAnalysis) : null;
}

/** Upsert a tenant's per-integration root-cause analysis (re-run overwrites). */
export function saveRcaResult(tenant: string, result: ErrorRcaResult): void {
  db().prepare(
    `INSERT INTO rca_results (tenant, integration, data, generated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(tenant, integration)
     DO UPDATE SET data = excluded.data, generated_at = excluded.generated_at`,
  ).run(tenant, result.integration, JSON.stringify(result), result.generatedAt);
}

/** All persisted RCAs for a tenant, newest first. */
export function listRcaResults(tenant: string): ErrorRcaResult[] {
  const rows = db()
    .prepare(`SELECT data FROM rca_results WHERE tenant = ? ORDER BY generated_at DESC`)
    .all(tenant) as { data: string }[];
  return rows.map((r) => JSON.parse(r.data) as ErrorRcaResult);
}

/** Delete persisted RCAs for a tenant (the "Clear" action), or one integration. */
export function deleteRcaResults(tenant: string, integration?: string): void {
  if (integration) {
    db().prepare(`DELETE FROM rca_results WHERE tenant = ? AND integration = ?`).run(tenant, integration);
  } else {
    db().prepare(`DELETE FROM rca_results WHERE tenant = ?`).run(tenant);
  }
}

/** Tenant slugs the user has starred (manual watch-list). */
export function listStarredTenants(): string[] {
  const rows = db()
    .prepare(`SELECT tenant FROM starred_tenants ORDER BY created_at`)
    .all() as { tenant: string }[];
  return rows.map((r) => r.tenant);
}

export function starTenant(tenant: string): void {
  db().prepare(
    `INSERT INTO starred_tenants (tenant) VALUES (?) ON CONFLICT(tenant) DO NOTHING`,
  ).run(tenant);
}

export function unstarTenant(tenant: string): void {
  db().prepare(`DELETE FROM starred_tenants WHERE tenant = ?`).run(tenant);
}

// --- health snapshots (trend history) -----------------------------------------

/** Bulk-insert one health-score snapshot per tenant at a shared timestamp. */
export function recordHealthSnapshots(rows: Array<{ tenant: string; score: number }>, ts: string): void {
  const conn = db();
  // OR IGNORE: the (tenant, ts) unique index makes a same-timestamp re-write a no-op.
  const stmt = conn.prepare(`INSERT OR IGNORE INTO health_snapshots (tenant, score, ts) VALUES (?, ?, ?)`);
  conn.exec("BEGIN");
  try {
    for (const r of rows) stmt.run(r.tenant, Math.round(r.score), ts);
    conn.exec("COMMIT");
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }
}

/** Timestamp of the most recent snapshot run, or null. */
export function latestSnapshotTs(): string | null {
  const row = db().prepare(`SELECT ts FROM health_snapshots ORDER BY ts DESC LIMIT 1`).get() as
    | { ts: string }
    | undefined;
  return row?.ts ?? null;
}

/** Score history for one tenant since `sinceIso` (ascending by time). */
export function listHealthSnapshots(tenant: string, sinceIso?: string): Array<{ t: string; score: number }> {
  const rows = sinceIso
    ? (db()
        .prepare(`SELECT ts, score FROM health_snapshots WHERE tenant = ? AND ts >= ? ORDER BY ts`)
        .all(tenant, sinceIso) as { ts: string; score: number }[])
    : (db()
        .prepare(`SELECT ts, score FROM health_snapshots WHERE tenant = ? ORDER BY ts`)
        .all(tenant) as { ts: string; score: number }[]);
  return rows.map((r) => ({ t: r.ts, score: r.score }));
}

/** All snapshots since `sinceIso`, grouped per tenant (for fleet sparklines). */
export function snapshotsByTenantSince(sinceIso: string): Map<string, Array<{ t: string; score: number }>> {
  const rows = db()
    .prepare(`SELECT tenant, ts, score FROM health_snapshots WHERE ts >= ? ORDER BY ts`)
    .all(sinceIso) as { tenant: string; ts: string; score: number }[];
  const m = new Map<string, Array<{ t: string; score: number }>>();
  for (const r of rows) {
    const list = m.get(r.tenant) ?? [];
    list.push({ t: r.ts, score: r.score });
    m.set(r.tenant, list);
  }
  return m;
}

/** Delete snapshots older than `beforeIso` (rolling-window prune). */
export function pruneHealthSnapshots(beforeIso: string): void {
  db().prepare(`DELETE FROM health_snapshots WHERE ts < ?`).run(beforeIso);
}

/* ---------- All Defects trend snapshots ---------- */

/**
 * Replace one day's rows for the given groups. Each call fully rewrites the
 * (day, grp) cells present in `points`, so a key that dropped to zero for that
 * group/day disappears rather than lingering.
 */
export function recordDefectSnapshot(
  day: string,
  points: Array<{ grp: string; key: string; count: number }>,
): void {
  const conn = db();
  const groups = new Set(points.map((p) => p.grp));
  const del = conn.prepare(`DELETE FROM defect_snapshots WHERE day = ? AND grp = ?`);
  const ins = conn.prepare(`INSERT INTO defect_snapshots (day, grp, k, count) VALUES (?, ?, ?, ?)`);
  conn.exec("BEGIN");
  try {
    for (const g of groups) del.run(day, g);
    for (const p of points) ins.run(day, p.grp, p.key, Math.round(p.count));
    conn.exec("COMMIT");
  } catch (e) {
    conn.exec("ROLLBACK");
    throw e;
  }
}

/** All defect snapshot rows on/after `sinceDay` (YYYY-MM-DD), ascending by day. */
export function listDefectSnapshots(
  sinceDay: string,
): Array<{ day: string; grp: string; key: string; count: number }> {
  const rows = db()
    .prepare(`SELECT day, grp, k, count FROM defect_snapshots WHERE day >= ? ORDER BY day`)
    .all(sinceDay) as Array<{ day: string; grp: string; k: string; count: number }>;
  return rows.map((r) => ({ day: r.day, grp: r.grp, key: r.k, count: r.count }));
}

/** Whether a snapshot exists for a given (day, group) — used to throttle daily writes. */
export function hasDefectSnapshot(day: string, grp: string): boolean {
  const row = db()
    .prepare(`SELECT 1 FROM defect_snapshots WHERE day = ? AND grp = ? LIMIT 1`)
    .get(day, grp) as { 1: number } | undefined;
  return row != null;
}

/** Delete defect snapshots older than `beforeDay` (rolling-window prune). */
export function pruneDefectSnapshots(beforeDay: string): void {
  db().prepare(`DELETE FROM defect_snapshots WHERE day < ?`).run(beforeDay);
}

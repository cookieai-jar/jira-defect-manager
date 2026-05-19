import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  JiraIssue,
  P0Customer,
  TriageReport,
  TicketAnalysis,
  Scope,
} from "@/types/triage";

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

export function latestSyncRun(scope: Scope) {
  return db()
    .prepare(`SELECT * FROM sync_runs WHERE scope = ? ORDER BY id DESC LIMIT 1`)
    .get(scope);
}

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { JiraIssue, P0Customer, TriageReport, TicketAnalysis } from "@/types/triage";

const DATA_DIR = join(process.cwd(), "data");
mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = join(DATA_DIR, "triage.db");

let _db: DatabaseSync | null = null;

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
  _db = conn;
  return conn;
}

export function saveIssue(issue: JiraIssue) {
  db().prepare(
    `INSERT INTO issues (key, data, synced_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET data = excluded.data, synced_at = CURRENT_TIMESTAMP`,
  ).run(issue.key, JSON.stringify(issue));
}

export function listIssues(): JiraIssue[] {
  const rows = db().prepare(`SELECT data FROM issues ORDER BY key`).all() as { data: string }[];
  return rows.map((r) => JSON.parse(r.data) as JiraIssue);
}

export function getIssue(key: string): JiraIssue | null {
  const row = db().prepare(`SELECT data FROM issues WHERE key = ?`).get(key) as
    | { data: string }
    | undefined;
  return row ? (JSON.parse(row.data) as JiraIssue) : null;
}

export function saveAnalysis(a: TicketAnalysis) {
  db().prepare(
    `INSERT INTO analyses (issue_key, data, generated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(issue_key) DO UPDATE SET data = excluded.data, generated_at = CURRENT_TIMESTAMP`,
  ).run(a.issueKey, JSON.stringify(a));
}

export function listAnalyses(): TicketAnalysis[] {
  const rows = db().prepare(`SELECT data FROM analyses`).all() as { data: string }[];
  return rows.map((r) => JSON.parse(r.data) as TicketAnalysis);
}

export function getAnalysis(key: string): TicketAnalysis | null {
  const row = db().prepare(`SELECT data FROM analyses WHERE issue_key = ?`).get(key) as
    | { data: string }
    | undefined;
  return row ? (JSON.parse(row.data) as TicketAnalysis) : null;
}

export function saveReport(report: TriageReport): number {
  const info = db().prepare(`INSERT INTO reports (data) VALUES (?)`).run(JSON.stringify(report));
  return Number(info.lastInsertRowid);
}

export function latestReport(): TriageReport | null {
  const row = db().prepare(`SELECT data FROM reports ORDER BY id DESC LIMIT 1`).get() as
    | { data: string }
    | undefined;
  return row ? (JSON.parse(row.data) as TriageReport) : null;
}

export function listP0(): P0Customer[] {
  const rows = db().prepare(`SELECT * FROM p0_customers ORDER BY name`).all() as Array<{
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

export function recordSyncStart(): number {
  const info = db().prepare(`INSERT INTO sync_runs (status) VALUES ('running')`).run();
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

export function latestSyncRun() {
  return db().prepare(`SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1`).get();
}

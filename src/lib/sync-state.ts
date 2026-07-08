import type { Scope } from "@/types/triage";

/**
 * Sync state lives in module scope so it persists across requests in the same Node process.
 * (Local-only tool, single user, single process — good enough.)
 * One state object per scope so EAC and FR sync independently.
 */

export interface SyncState {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  phase: "idle" | "jira" | "tickets" | "p0" | "done" | "error";
  message: string;
  done: number;
  total: number;
  issuesPulled: number;
  issuesAnalyzed: number;
  error: string | null;
}

function initial(): SyncState {
  return {
    running: false,
    startedAt: null,
    finishedAt: null,
    phase: "idle",
    message: "Idle",
    done: 0,
    total: 0,
    issuesPulled: 0,
    issuesAnalyzed: 0,
    error: null,
  };
}

const states: Record<Scope, SyncState> = {
  eac: initial(),
  fr: initial(),
  sec: initial(),
  alerts: initial(),
  incidents: initial(),
};

export function getSyncState(scope: Scope): SyncState {
  return { ...states[scope] };
}

export function setSyncState(scope: Scope, patch: Partial<SyncState>) {
  Object.assign(states[scope], patch);
}

export function startSyncState(scope: Scope) {
  Object.assign(states[scope], {
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    phase: "jira",
    message: "Starting…",
    done: 0,
    total: 0,
    issuesPulled: 0,
    issuesAnalyzed: 0,
    error: null,
  });
}

export function finishSyncState(scope: Scope, error: string | null = null) {
  Object.assign(states[scope], {
    running: false,
    finishedAt: new Date().toISOString(),
    phase: error ? "error" : "done",
    message: error ?? "Done",
    error,
  });
}

/** A row from the sync_runs table (db.latestSyncRun). Timestamps are SQLite UTC. */
export interface SyncRunRow {
  started_at?: string | null;
  finished_at?: string | null;
  status?: string | null;
  issues_pulled?: number | null;
  issues_analyzed?: number | null;
  error?: string | null;
}

/** A background run older than this with no finish is treated as no longer running. */
const RUNNING_STALE_MS = 30 * 60 * 1000;

/** SQLite "YYYY-MM-DD HH:MM:SS" (UTC) -> ISO, or null. */
function dbTimeToIso(s: string | null | undefined): string | null {
  return s ? new Date(`${s.replace(" ", "T")}Z`).toISOString() : null;
}

/**
 * PURE. Reconcile the in-process sync state with the latest sync_runs row so the
 * "Last sync" indicator reflects syncs that ran in another context (e.g. the
 * server-side scheduler / a different dev worker). In-memory wins while a local
 * sync is live (it has live progress); otherwise the DB fills in a newer finish
 * or a recent background run.
 */
export function mergeSyncState(
  inMem: SyncState,
  row: SyncRunRow | null | undefined,
  now: number,
): SyncState {
  if (!row || inMem.running) return inMem;

  // A background sync currently in progress (started recently, not yet finished).
  if (row.status === "running" && !row.finished_at) {
    const startedAt = dbTimeToIso(row.started_at);
    const startedMs = startedAt ? Date.parse(startedAt) : NaN;
    if (Number.isFinite(startedMs) && now - startedMs < RUNNING_STALE_MS) {
      return {
        ...inMem,
        running: true,
        startedAt,
        phase: "jira",
        message: "Syncing in background…",
        error: null,
      };
    }
    return inMem; // stale running row — ignore
  }

  // A completed run more recent than what we have in memory.
  const dbFinishedAt = dbTimeToIso(row.finished_at);
  if (dbFinishedAt && (!inMem.finishedAt || dbFinishedAt > inMem.finishedAt)) {
    const isError = row.status === "error";
    return {
      ...inMem,
      finishedAt: dbFinishedAt,
      phase: isError ? "error" : "done",
      message: isError ? row.error ?? "Error" : "Done",
      error: isError ? row.error ?? "error" : null,
      issuesPulled: row.issues_pulled ?? inMem.issuesPulled,
      issuesAnalyzed: row.issues_analyzed ?? inMem.issuesAnalyzed,
    };
  }
  return inMem;
}

/**
 * Sync state lives in module scope so it persists across requests in the same Node process.
 * (Local-only tool, single user, single process — good enough.)
 */

export interface SyncState {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  phase: "idle" | "jira" | "tickets" | "p0" | "plan" | "done" | "error";
  message: string;
  done: number;
  total: number;
  issuesPulled: number;
  issuesAnalyzed: number;
  error: string | null;
}

const state: SyncState = {
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

export function getSyncState(): SyncState {
  return { ...state };
}

export function setSyncState(patch: Partial<SyncState>) {
  Object.assign(state, patch);
}

export function startSyncState() {
  Object.assign(state, {
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

export function finishSyncState(error: string | null = null) {
  Object.assign(state, {
    running: false,
    finishedAt: new Date().toISOString(),
    phase: error ? "error" : "done",
    message: error ?? "Done",
    error,
  });
}

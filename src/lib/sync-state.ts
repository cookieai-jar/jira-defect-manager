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

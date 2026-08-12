/**
 * Sync state for the Product Defect Analysis dashboard. A single module-scope
 * object (local-only tool, single process). Kept separate from the Strategic
 * Integrations state because its pipeline is longer: code correlation and
 * metrics run before the LLM phases, and the synthesis fans out into deep
 * dives, prevention strategies and per-team plans.
 */

export type ProductDefectsPhase =
  | "idle"
  | "jira"
  | "correlate"
  | "metrics"
  | "extract"
  | "synthesize"
  | "deep-dive"
  | "strategies"
  | "teams"
  | "components"
  | "done"
  | "error";

export interface ProductDefectsSyncState {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  phase: ProductDefectsPhase;
  message: string;
  done: number;
  total: number;
  issuesPulled: number;
  issuesAnalyzed: number;
  error: string | null;
}

export function initialProductDefectsSyncState(): ProductDefectsSyncState {
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

let state: ProductDefectsSyncState = initialProductDefectsSyncState();

export function getProductDefectsSyncState(): ProductDefectsSyncState {
  return { ...state };
}

export function setProductDefectsSyncState(patch: Partial<ProductDefectsSyncState>) {
  state = { ...state, ...patch };
}

export function startProductDefectsSyncState() {
  state = {
    ...initialProductDefectsSyncState(),
    running: true,
    startedAt: new Date().toISOString(),
    phase: "jira",
    message: "Starting…",
  };
}

export function finishProductDefectsSyncState(error: string | null = null) {
  state = {
    ...state,
    running: false,
    finishedAt: new Date().toISOString(),
    phase: error ? "error" : "done",
    message: error ?? "Done",
    error,
  };
}

/** Test-only: reset module state between cases. */
export function __resetProductDefectsSyncState() {
  state = initialProductDefectsSyncState();
}

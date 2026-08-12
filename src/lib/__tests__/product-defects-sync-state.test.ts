import { describe, it, expect, beforeEach } from "vitest";
import {
  __resetProductDefectsSyncState,
  finishProductDefectsSyncState,
  getProductDefectsSyncState,
  initialProductDefectsSyncState,
  setProductDefectsSyncState,
  startProductDefectsSyncState,
} from "@/lib/product-defects-sync-state";

beforeEach(() => __resetProductDefectsSyncState());

describe("product defects sync state", () => {
  it("starts idle", () => {
    const s = getProductDefectsSyncState();
    expect(s.running).toBe(false);
    expect(s.phase).toBe("idle");
    expect(s.error).toBeNull();
  });

  it("start marks running and clears prior counters", () => {
    setProductDefectsSyncState({ issuesPulled: 99 });
    startProductDefectsSyncState();
    const s = getProductDefectsSyncState();
    expect(s.running).toBe(true);
    expect(s.phase).toBe("jira");
    expect(s.startedAt).not.toBeNull();
    expect(s.issuesPulled).toBe(0); // reset
  });

  it("setProductDefectsSyncState patches fields", () => {
    setProductDefectsSyncState({ phase: "correlate", done: 3, total: 5, message: "x" });
    const s = getProductDefectsSyncState();
    expect(s.phase).toBe("correlate");
    expect(s.done).toBe(3);
    expect(s.total).toBe(5);
  });

  it("walks the pipeline phases", () => {
    startProductDefectsSyncState();
    for (const phase of ["correlate", "metrics", "extract", "synthesize", "deep-dive", "strategies", "teams"] as const) {
      setProductDefectsSyncState({ phase });
      expect(getProductDefectsSyncState().phase).toBe(phase);
    }
  });

  it("finish (success) sets done phase and clears error", () => {
    startProductDefectsSyncState();
    finishProductDefectsSyncState();
    const s = getProductDefectsSyncState();
    expect(s.running).toBe(false);
    expect(s.phase).toBe("done");
    expect(s.error).toBeNull();
    expect(s.finishedAt).not.toBeNull();
  });

  it("finish (error) records the error and error phase", () => {
    startProductDefectsSyncState();
    finishProductDefectsSyncState("boom");
    const s = getProductDefectsSyncState();
    expect(s.running).toBe(false);
    expect(s.phase).toBe("error");
    expect(s.error).toBe("boom");
  });

  it("reset returns to the initial state", () => {
    startProductDefectsSyncState();
    setProductDefectsSyncState({ phase: "teams", issuesAnalyzed: 42 });
    __resetProductDefectsSyncState();
    expect(getProductDefectsSyncState()).toEqual(initialProductDefectsSyncState());
  });

  it("getProductDefectsSyncState returns a copy (no external mutation)", () => {
    const s = getProductDefectsSyncState();
    s.running = true;
    expect(getProductDefectsSyncState().running).toBe(false);
  });

  it("initial factory is independent each call", () => {
    const a = initialProductDefectsSyncState();
    a.done = 5;
    expect(initialProductDefectsSyncState().done).toBe(0);
  });
});

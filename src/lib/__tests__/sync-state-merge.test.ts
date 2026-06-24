import { describe, it, expect } from "vitest";
import { mergeSyncState, type SyncState, type SyncRunRow } from "@/lib/sync-state";

const NOW = Date.parse("2026-06-24T22:00:00Z");

function idle(over: Partial<SyncState> = {}): SyncState {
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
    ...over,
  };
}

describe("mergeSyncState", () => {
  it("returns in-memory unchanged when there is no DB row", () => {
    const s = idle({ finishedAt: "2026-06-24T21:00:00.000Z" });
    expect(mergeSyncState(s, null, NOW)).toBe(s);
  });

  it("keeps the live in-memory state while a local sync is running", () => {
    const live = idle({ running: true, phase: "tickets", message: "Analyzing", done: 2, total: 5 });
    const row: SyncRunRow = { finished_at: "2026-06-24 21:55:00", status: "success" };
    expect(mergeSyncState(live, row, NOW)).toBe(live); // unchanged
  });

  it("surfaces a newer completed DB run as the last sync", () => {
    const s = idle({ finishedAt: "2026-06-24T20:00:00.000Z" });
    const row: SyncRunRow = {
      finished_at: "2026-06-24 21:55:41", // UTC, newer
      status: "success",
      issues_pulled: 21,
      issues_analyzed: 21,
    };
    const out = mergeSyncState(s, row, NOW);
    expect(out.finishedAt).toBe("2026-06-24T21:55:41.000Z");
    expect(out.phase).toBe("done");
    expect(out.issuesPulled).toBe(21);
    expect(out.error).toBeNull();
  });

  it("fills in last sync when in-memory has none", () => {
    const out = mergeSyncState(idle(), { finished_at: "2026-06-24 21:55:41", status: "success" }, NOW);
    expect(out.finishedAt).toBe("2026-06-24T21:55:41.000Z");
  });

  it("does NOT override when the DB run is older than in-memory", () => {
    const s = idle({ finishedAt: "2026-06-24T21:59:00.000Z" });
    const out = mergeSyncState(s, { finished_at: "2026-06-24 21:00:00", status: "success" }, NOW);
    expect(out.finishedAt).toBe("2026-06-24T21:59:00.000Z");
  });

  it("reflects a recent background run as running", () => {
    const row: SyncRunRow = { started_at: "2026-06-24 21:58:00", finished_at: null, status: "running" };
    const out = mergeSyncState(idle(), row, NOW); // started 2 min ago
    expect(out.running).toBe(true);
    expect(out.message).toMatch(/background/i);
  });

  it("ignores a stale running row (started long ago, never finished)", () => {
    const row: SyncRunRow = { started_at: "2026-06-24 20:00:00", finished_at: null, status: "running" };
    const out = mergeSyncState(idle(), row, NOW); // 2h old
    expect(out.running).toBe(false);
  });

  it("surfaces a DB error as the last sync error", () => {
    const out = mergeSyncState(
      idle(),
      { finished_at: "2026-06-24 21:55:41", status: "error", error: "JIRA 401" },
      NOW,
    );
    expect(out.phase).toBe("error");
    expect(out.error).toBe("JIRA 401");
  });
});

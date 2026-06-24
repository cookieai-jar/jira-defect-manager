import { describe, it, expect } from "vitest";
import {
  autoSyncScopes,
  dueForSync,
  runSchedulerTick,
  type ScopeSyncSnapshot,
} from "@/lib/scheduler";
import type { Scope } from "@/types/triage";

const HOUR = 60 * 60 * 1000;
const NOW = 1_000_000_000_000; // fixed "now"

describe("autoSyncScopes", () => {
  it("returns all three triage scopes when dashboards are enabled", () => {
    expect(autoSyncScopes({ dashboards: { eac: true, fr: true, sec: true } })).toEqual([
      "eac",
      "fr",
      "sec",
    ]);
  });
  it("excludes scopes whose dashboard is disabled", () => {
    expect(autoSyncScopes({ dashboards: { eac: true, fr: false, sec: true } })).toEqual([
      "eac",
      "sec",
    ]);
  });
  it("treats missing dashboard flags as enabled (only explicit false excludes)", () => {
    expect(autoSyncScopes({ dashboards: {} as never })).toEqual(["eac", "fr", "sec"]);
  });
});

describe("dueForSync", () => {
  it("is due when never synced or timestamp is unparseable", () => {
    expect(dueForSync(null, NOW, HOUR)).toBe(true);
    expect(dueForSync(undefined, NOW, HOUR)).toBe(true);
    expect(dueForSync("not-a-date", NOW, HOUR)).toBe(true);
  });
  it("is due when the last sync finished at least an interval ago (inclusive)", () => {
    expect(dueForSync(new Date(NOW - HOUR).toISOString(), NOW, HOUR)).toBe(true); // exactly 1h
    expect(dueForSync(new Date(NOW - 2 * HOUR).toISOString(), NOW, HOUR)).toBe(true);
  });
  it("is NOT due when the last sync is more recent than the interval", () => {
    expect(dueForSync(new Date(NOW - HOUR + 1).toISOString(), NOW, HOUR)).toBe(false);
    expect(dueForSync(new Date(NOW).toISOString(), NOW, HOUR)).toBe(false);
  });
});

describe("runSchedulerTick", () => {
  function harness(states: Record<string, ScopeSyncSnapshot>, scopes: Scope[] = ["eac", "fr", "sec"]) {
    const triggered: Scope[] = [];
    const result = runSchedulerTick({
      scopes,
      now: NOW,
      intervalMs: HOUR,
      getState: (s) => states[s] ?? { running: false, finishedAt: null },
      trigger: (s) => triggered.push(s),
    });
    return { result, triggered };
  }

  it("triggers scopes that are due and not running", () => {
    const stale = new Date(NOW - 2 * HOUR).toISOString();
    const { result, triggered } = harness({
      eac: { running: false, finishedAt: stale },
      fr: { running: false, finishedAt: null }, // never synced
      sec: { running: false, finishedAt: stale },
    });
    expect(result).toEqual(["eac", "fr", "sec"]);
    expect(triggered).toEqual(["eac", "fr", "sec"]);
  });

  it("skips scopes that are already running", () => {
    const stale = new Date(NOW - 2 * HOUR).toISOString();
    const { triggered } = harness({
      eac: { running: true, finishedAt: stale }, // running -> skip
      fr: { running: false, finishedAt: stale },
      sec: { running: false, finishedAt: stale },
    });
    expect(triggered).toEqual(["fr", "sec"]);
  });

  it("skips scopes synced within the interval", () => {
    const fresh = new Date(NOW - 5 * 60 * 1000).toISOString(); // 5 min ago
    const stale = new Date(NOW - 2 * HOUR).toISOString();
    const { triggered } = harness({
      eac: { running: false, finishedAt: fresh }, // fresh -> skip
      fr: { running: false, finishedAt: stale },
      sec: { running: false, finishedAt: fresh }, // fresh -> skip
    });
    expect(triggered).toEqual(["fr"]);
  });

  it("triggers nothing when all scopes are fresh", () => {
    const fresh = new Date(NOW - 60 * 1000).toISOString();
    const { triggered } = harness({
      eac: { running: false, finishedAt: fresh },
      fr: { running: false, finishedAt: fresh },
      sec: { running: false, finishedAt: fresh },
    });
    expect(triggered).toEqual([]);
  });

  it("only considers the scopes it is given", () => {
    const { triggered } = harness({ eac: { running: false, finishedAt: null } }, ["eac"]);
    expect(triggered).toEqual(["eac"]);
  });
});

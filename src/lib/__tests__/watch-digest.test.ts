import { describe, it, expect } from "vitest";
import { buildWatchDigest, attentionReasons } from "@/lib/watch-digest";
import type { FleetTenantSummary } from "@/types/tenant";

function t(over: Partial<FleetTenantSummary> = {}): FleetTenantSummary {
  return {
    tenant: "acme",
    displayName: "Acme",
    extractions: 0,
    extractionErrors: 0,
    integrations: 0,
    activeAlerts: 0,
    criticalAlerts: 0,
    warningAlerts: 0,
    healthScore: 100,
    severity: "ok",
    topIssue: null,
    whiteGlove: false,
    pendingExtractJobs: 0,
    trend: [],
    healthDelta: null,
    ...over,
  };
}

describe("attentionReasons", () => {
  it("flags critical alerts, unhealthy score, and big drops (severity order)", () => {
    expect(attentionReasons(t({ healthScore: 30, healthDelta: -16, criticalAlerts: 3 }))).toEqual([
      "3 critical alerts",
      "unhealthy (30/100)",
      "dropped 16 pts",
    ]);
  });
  it("is empty for a steady healthy tenant", () => {
    expect(attentionReasons(t({ healthScore: 95, healthDelta: -3 }))).toEqual([]);
  });
  it("does not flag a small dip or a healthy score with no critical alerts", () => {
    expect(attentionReasons(t({ healthScore: 88, healthDelta: -9 }))).toEqual([]); // -9 < threshold 10
    expect(attentionReasons(t({ healthScore: 60, healthDelta: 5 }))).toEqual([]); // 60 >= 50, improving
  });
  it("flags an improving-but-still-unhealthy tenant on the score alone", () => {
    expect(attentionReasons(t({ healthScore: 28, healthDelta: 4 }))).toEqual(["unhealthy (28/100)"]);
  });
});

describe("buildWatchDigest", () => {
  it("partitions watched tenants into attention (worst-first) vs steady", () => {
    const d = buildWatchDigest([
      t({ tenant: "good", healthScore: 95 }),
      t({ tenant: "bad", healthScore: 20, healthDelta: -30, criticalAlerts: 2 }),
      t({ tenant: "mid", healthScore: 45 }),
      t({ tenant: "fine", healthScore: 82, healthDelta: -2 }),
    ]);
    expect(d.total).toBe(4);
    expect(d.steadyCount).toBe(2); // good + fine
    expect(d.attention.map((x) => x.tenant)).toEqual(["bad", "mid"]); // worst-first
    expect(d.attention[0].reasons).toContain("2 critical alerts");
  });
  it("empty watch-list → all steady", () => {
    expect(buildWatchDigest([])).toEqual({ total: 0, attention: [], steadyCount: 0 });
  });
});

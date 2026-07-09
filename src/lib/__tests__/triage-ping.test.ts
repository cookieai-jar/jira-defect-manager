import { describe, it, expect } from "vitest";
import { buildUpdateRequestComment, updatePingStats } from "../triage-ping-core";

describe("buildUpdateRequestComment", () => {
  it("mentions the assignee and includes the marker", () => {
    const doc = buildUpdateRequestComment({ assigneeAccountId: "acc-1", assigneeName: "Ricky" });
    expect(doc).not.toBeNull();
    const json = JSON.stringify(doc);
    expect(json).toContain("acc-1");
    expect(json).toContain("@Ricky");
    expect(json.toLowerCase()).toContain("(update requested)");
  });
  it("returns null when unassigned (no one to ping)", () => {
    expect(buildUpdateRequestComment({ assigneeAccountId: null, assigneeName: null })).toBeNull();
  });
});

describe("updatePingStats", () => {
  it("counts only our update-request comments and finds the latest", () => {
    const stats = updatePingStats([
      { createdAt: "2026-01-01T00:00:00Z", text: "unrelated comment" },
      { createdAt: "2026-02-01T00:00:00Z", text: "@Ricky — please post a status update. (Update requested)" },
      { createdAt: "2026-03-01T00:00:00Z", text: "@Ricky — status update? (Update requested)" },
    ]);
    expect(stats.count).toBe(2);
    expect(stats.lastPingedAt).toBe("2026-03-01T00:00:00Z");
  });
  it("is empty when there are no ping comments", () => {
    expect(updatePingStats([{ createdAt: "2026-01-01T00:00:00Z", text: "hi" }])).toEqual({
      count: 0,
      lastPingedAt: null,
    });
  });
  it("does not match the roadmap '(Auto flagged)' marker", () => {
    const stats = updatePingStats([
      { createdAt: "2026-01-01T00:00:00Z", text: "@x please add fields. (Auto flagged)" },
    ]);
    expect(stats.count).toBe(0);
  });
});

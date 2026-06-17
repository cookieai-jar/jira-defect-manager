import { describe, it, expect } from "vitest";
import {
  ownershipLoad,
  blockedItems,
  UNASSIGNED,
  type Row,
} from "@/lib/fr-team-load";
import type { JiraIssue, TicketAnalysis } from "@/types/triage";

// ---- minimal inline fixtures -------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * DAY).toISOString();
}

function issue(over: Partial<JiraIssue> = {}): JiraIssue {
  return {
    key: "FR-1",
    summary: "A feature request",
    status: "Open",
    statusCategory: "new",
    priority: null,
    issueType: "Story",
    reporter: null,
    assignee: null,
    created: isoDaysAgo(10),
    updated: isoDaysAgo(1),
    resolved: null,
    labels: [],
    components: [],
    url: "https://jira/FR-1",
    description: null,
    comments: [],
    parent: null,
    ...over,
  };
}

function row(
  status: TicketAnalysis["status"],
  over: { issue?: Partial<JiraIssue>; analysis?: Partial<TicketAnalysis> } = {},
): Row {
  const analysis: TicketAnalysis = {
    issueKey: over.issue?.key ?? "FR-1",
    severityScore: 5,
    temperature: "warm",
    temperatureScore: 5,
    customer: null,
    isP0Customer: false,
    status,
    daysSinceUpdate: 1,
    recommendation: "continue",
    rationale: "",
    nextStep: "",
    suggestedSprint: null,
    evidenceQuotes: [],
    ...over.analysis,
  };
  const iss = issue({ key: analysis.issueKey, ...over.issue });
  return { ...analysis, issue: iss };
}

// ---- ownershipLoad -----------------------------------------------------------

describe("ownershipLoad", () => {
  it("groups open rows by assignee and counts them", () => {
    const rows = [
      row("active", { issue: { key: "A-1", assignee: "Alice" } }),
      row("blocked", { issue: { key: "A-2", assignee: "Alice" } }),
      row("stalled", { issue: { key: "B-1", assignee: "Bob" } }),
    ];
    const out = ownershipLoad(rows);
    const alice = out.entries.find((e) => e.assignee === "Alice")!;
    expect(alice.count).toBe(2);
    expect(alice.rows.map((r) => r.issueKey).sort()).toEqual(["A-1", "A-2"]);
    expect(out.entries.find((e) => e.assignee === "Bob")!.count).toBe(1);
  });

  it("buckets null and empty assignee names as Unassigned", () => {
    const rows = [
      row("active", { issue: { key: "U-1", assignee: null } }),
      row("active", { issue: { key: "U-2", assignee: "   " } }),
      row("active", { issue: { key: "U-3", assignee: "" } }),
    ];
    const out = ownershipLoad(rows);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0].assignee).toBe(UNASSIGNED);
    expect(out.entries[0].count).toBe(3);
  });

  it("sorts entries by count descending", () => {
    const rows = [
      row("active", { issue: { key: "B-1", assignee: "Bob" } }),
      row("active", { issue: { key: "A-1", assignee: "Alice" } }),
      row("active", { issue: { key: "A-2", assignee: "Alice" } }),
      row("active", { issue: { key: "A-3", assignee: "Alice" } }),
      row("active", { issue: { key: "C-1", assignee: "Carol" } }),
      row("active", { issue: { key: "C-2", assignee: "Carol" } }),
    ];
    const out = ownershipLoad(rows);
    expect(out.entries.map((e) => e.assignee)).toEqual(["Alice", "Carol", "Bob"]);
  });

  it("keeps Unassigned last among equal counts", () => {
    const rows = [
      row("active", { issue: { key: "U-1", assignee: null } }),
      row("active", { issue: { key: "Z-1", assignee: "Zoe" } }),
    ];
    const out = ownershipLoad(rows);
    expect(out.entries.map((e) => e.assignee)).toEqual(["Zoe", UNASSIGNED]);
  });

  it("computes max and total over open rows only", () => {
    const rows = [
      row("active", { issue: { key: "A-1", assignee: "Alice" } }),
      row("blocked", { issue: { key: "A-2", assignee: "Alice" } }),
      row("stalled", { issue: { key: "B-1", assignee: "Bob" } }),
    ];
    const out = ownershipLoad(rows);
    expect(out.max).toBe(2);
    expect(out.total).toBe(3);
  });

  it("excludes resolved rows", () => {
    const rows = [
      row("resolved", { issue: { key: "A-1", assignee: "Alice" } }),
      row("active", { issue: { key: "B-1", assignee: "Bob" } }),
    ];
    const out = ownershipLoad(rows);
    expect(out.total).toBe(1);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0].assignee).toBe("Bob");
  });

  it("handles empty input", () => {
    const out = ownershipLoad([]);
    expect(out.entries).toEqual([]);
    expect(out.max).toBe(0);
    expect(out.total).toBe(0);
  });
});

// ---- blockedItems ------------------------------------------------------------

describe("blockedItems", () => {
  it("includes only blocked-status rows", () => {
    const rows = [
      row("blocked", { issue: { key: "X-1" } }),
      row("active", { issue: { key: "X-2" } }),
      row("resolved", { issue: { key: "X-3" } }),
      row("stalled", { issue: { key: "X-4" } }),
    ];
    const out = blockedItems(rows);
    expect(out.map((b) => b.key)).toEqual(["X-1"]);
  });

  it("prefers nextStep for the reason", () => {
    const out = blockedItems([
      row("blocked", {
        analysis: { nextStep: "Ping vendor", rationale: "Waiting on API" },
      }),
    ]);
    expect(out[0].reason).toBe("Ping vendor");
  });

  it("falls back to rationale when nextStep is empty", () => {
    const out = blockedItems([
      row("blocked", { analysis: { nextStep: "   ", rationale: "Waiting on API" } }),
    ]);
    expect(out[0].reason).toBe("Waiting on API");
  });

  it("falls back to a default when neither is present", () => {
    const out = blockedItems([
      row("blocked", { analysis: { nextStep: "", rationale: "" } }),
    ]);
    expect(out[0].reason).toBe("No reason recorded");
  });

  it("computes ageDays and sorts by it descending", () => {
    const out = blockedItems([
      row("blocked", { issue: { key: "NEW", updated: isoDaysAgo(2) } }),
      row("blocked", { issue: { key: "OLD", updated: isoDaysAgo(40) } }),
      row("blocked", { issue: { key: "MID", updated: isoDaysAgo(10) } }),
    ]);
    expect(out.map((b) => b.key)).toEqual(["OLD", "MID", "NEW"]);
    expect(out[0].ageDays).toBe(40);
    expect(out[2].ageDays).toBe(2);
  });

  it("handles empty input", () => {
    expect(blockedItems([])).toEqual([]);
  });
});

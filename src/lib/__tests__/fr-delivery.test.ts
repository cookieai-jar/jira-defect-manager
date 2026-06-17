import { describe, it, expect } from "vitest";
import { sprintPlan, epicOrphans, inFlightAging, type DeliveryRow } from "@/lib/fr-delivery";
import type { JiraIssue, TicketAnalysis } from "@/types/triage";

// --- minimal fixtures -------------------------------------------------------

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function issue(over: Partial<JiraIssue> = {}): JiraIssue {
  return {
    key: "FR-1",
    summary: "An FR",
    status: "In Progress",
    statusCategory: "indeterminate",
    priority: null,
    issueType: "Story",
    reporter: null,
    assignee: null,
    created: daysAgoIso(60),
    updated: daysAgoIso(1),
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
  over: Partial<Omit<DeliveryRow, "issue">> & { issue?: Partial<JiraIssue> } = {},
): DeliveryRow {
  const { issue: issueOver, ...rest } = over;
  const analysis: TicketAnalysis = {
    issueKey: "FR-1",
    severityScore: 5,
    temperature: "warm",
    temperatureScore: 5,
    customer: null,
    isP0Customer: false,
    status: "active",
    daysSinceUpdate: 1,
    recommendation: "continue",
    rationale: "",
    nextStep: "",
    suggestedSprint: null,
    evidenceQuotes: [],
    ...rest,
  };
  return { ...analysis, issue: issue({ key: analysis.issueKey, ...issueOver }) };
}

// --- sprintPlan -------------------------------------------------------------

describe("sprintPlan", () => {
  it("buckets by suggestedSprint with null -> backlog, in fixed order", () => {
    const rows = [
      row({ issueKey: "A", suggestedSprint: 1 }),
      row({ issueKey: "B", suggestedSprint: 2 }),
      row({ issueKey: "C", suggestedSprint: null }),
    ];
    const plan = sprintPlan(rows);
    expect(plan.map((b) => b.key)).toEqual(["sprint-1", "sprint-2", "backlog"]);
    expect(plan.map((b) => b.label)).toEqual(["Sprint 1", "Sprint 2", "Backlog"]);
    expect(plan[0].rows.map((r) => r.issueKey)).toEqual(["A"]);
    expect(plan[1].rows.map((r) => r.issueKey)).toEqual(["B"]);
    expect(plan[2].rows.map((r) => r.issueKey)).toEqual(["C"]);
    expect(plan.map((b) => b.count)).toEqual([1, 1, 1]);
  });

  it("sorts within a bucket by temperatureScore + severityScore desc", () => {
    const rows = [
      row({ issueKey: "low", suggestedSprint: 1, temperatureScore: 2, severityScore: 2 }),
      row({ issueKey: "high", suggestedSprint: 1, temperatureScore: 9, severityScore: 8 }),
      row({ issueKey: "mid", suggestedSprint: 1, temperatureScore: 5, severityScore: 5 }),
    ];
    const sprint1 = sprintPlan(rows).find((b) => b.key === "sprint-1")!;
    expect(sprint1.rows.map((r) => r.issueKey)).toEqual(["high", "mid", "low"]);
  });

  it("excludes resolved rows from every bucket", () => {
    const rows = [
      row({ issueKey: "done", suggestedSprint: 1, status: "resolved" }),
      row({ issueKey: "open", suggestedSprint: 1, status: "active" }),
    ];
    const sprint1 = sprintPlan(rows).find((b) => b.key === "sprint-1")!;
    expect(sprint1.rows.map((r) => r.issueKey)).toEqual(["open"]);
    expect(sprint1.count).toBe(1);
  });

  it("returns three empty buckets for empty input", () => {
    const plan = sprintPlan([]);
    expect(plan.map((b) => b.key)).toEqual(["sprint-1", "sprint-2", "backlog"]);
    expect(plan.every((b) => b.count === 0 && b.rows.length === 0)).toBe(true);
  });
});

// --- epicOrphans ------------------------------------------------------------

describe("epicOrphans", () => {
  it("includes open rows with no epic parent (null or non-Epic parent)", () => {
    const rows = [
      row({ issueKey: "noParent", issue: { parent: null } }),
      row({
        issueKey: "storyParent",
        issue: { parent: { key: "S-1", summary: "story", type: "Story" } },
      }),
      row({
        issueKey: "epicParent",
        issue: { parent: { key: "E-1", summary: "epic", type: "Epic" } },
      }),
    ];
    const out = epicOrphans(rows);
    expect(out.count).toBe(2);
    expect(out.rows.map((r) => r.issueKey).sort()).toEqual(["noParent", "storyParent"]);
  });

  it("treats Epic parent case-insensitively as attached (not an orphan)", () => {
    const rows = [
      row({ issueKey: "epicLower", issue: { parent: { key: "E-1", summary: "e", type: "epic" } } }),
    ];
    expect(epicOrphans(rows).count).toBe(0);
  });

  it("excludes resolved rows even when they have no epic", () => {
    const rows = [
      row({ issueKey: "resolvedOrphan", status: "resolved", issue: { parent: null } }),
    ];
    expect(epicOrphans(rows).count).toBe(0);
  });

  it("returns empty for empty input", () => {
    const out = epicOrphans([]);
    expect(out.count).toBe(0);
    expect(out.rows).toEqual([]);
  });
});

// --- inFlightAging ----------------------------------------------------------

describe("inFlightAging", () => {
  it("includes in-flight rows quiet for exactly the threshold (inclusive)", () => {
    const rows = [
      row({ issueKey: "exactly14", status: "active", issue: { updated: daysAgoIso(14) } }),
    ];
    const out = inFlightAging(rows, 14);
    expect(out.map((a) => a.row.issueKey)).toEqual(["exactly14"]);
    expect(out[0].daysQuiet).toBe(14);
  });

  it("excludes in-flight rows updated more recently than the threshold", () => {
    const rows = [
      row({ issueKey: "fresh", status: "active", issue: { updated: daysAgoIso(5) } }),
    ];
    expect(inFlightAging(rows, 14)).toEqual([]);
  });

  it("excludes non-in-flight rows (stalled/ready-to-close) even when stale", () => {
    const rows = [
      row({ issueKey: "stalled", status: "stalled", issue: { updated: daysAgoIso(90) } }),
      row({ issueKey: "ready", status: "ready-to-close", issue: { updated: daysAgoIso(90) } }),
      row({ issueKey: "blocked", status: "blocked", issue: { updated: daysAgoIso(90) } }),
    ];
    const out = inFlightAging(rows, 14);
    expect(out.map((a) => a.row.issueKey)).toEqual(["blocked"]);
  });

  it("excludes resolved rows", () => {
    const rows = [
      row({ issueKey: "resolved", status: "resolved", issue: { updated: daysAgoIso(90) } }),
    ];
    expect(inFlightAging(rows, 14)).toEqual([]);
  });

  it("sorts by staleness descending", () => {
    const rows = [
      row({ issueKey: "old20", status: "active", issue: { updated: daysAgoIso(20) } }),
      row({ issueKey: "old60", status: "blocked", issue: { updated: daysAgoIso(60) } }),
      row({ issueKey: "old30", status: "active", issue: { updated: daysAgoIso(30) } }),
    ];
    const out = inFlightAging(rows, 14);
    expect(out.map((a) => a.row.issueKey)).toEqual(["old60", "old30", "old20"]);
  });

  it("uses a default threshold of 14 days", () => {
    const rows = [
      row({ issueKey: "d13", status: "active", issue: { updated: daysAgoIso(13) } }),
      row({ issueKey: "d15", status: "active", issue: { updated: daysAgoIso(15) } }),
    ];
    expect(inFlightAging(rows).map((a) => a.row.issueKey)).toEqual(["d15"]);
  });

  it("returns empty for empty input", () => {
    expect(inFlightAging([], 14)).toEqual([]);
  });
});

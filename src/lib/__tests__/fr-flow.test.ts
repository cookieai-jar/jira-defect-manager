import { describe, it, expect } from "vitest";
import {
  flowSummary,
  mapRecommendationToAction,
  decisionsNeeded,
  type Row,
} from "@/lib/fr-flow";
import type { JiraIssue, TicketAnalysis, TrendBucket } from "@/types/triage";

function issue(key: string, summary = `summary ${key}`): JiraIssue {
  return {
    key,
    summary,
    status: "Open",
    statusCategory: "indeterminate",
    priority: null,
    issueType: "Story",
    reporter: null,
    assignee: null,
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
    resolved: null,
    labels: [],
    components: [],
    url: `https://jira/${key}`,
    description: null,
    comments: [],
    parent: null,
    customers: [],
    targetedMonth: null,
  };
}

function row(over: Partial<Row> & Pick<TicketAnalysis, "issueKey">): Row {
  const key = over.issueKey;
  const base: Row = {
    issueKey: key,
    severityScore: 5,
    temperature: "warm",
    temperatureScore: 5,
    customer: null,
    isP0Customer: false,
    status: "active",
    daysSinceUpdate: 0,
    recommendation: "continue",
    rationale: `rationale ${key}`,
    nextStep: `next ${key}`,
    suggestedSprint: null,
    evidenceQuotes: [],
    issue: issue(key),
  };
  return { ...base, ...over, issue: over.issue ?? base.issue };
}

function bucket(date: string, created: number, resolved: number): TrendBucket {
  return { date, created, resolved };
}

describe("flowSummary", () => {
  it("treats undefined trend as zeros + hasTrend false", () => {
    const out = flowSummary(undefined, []);
    expect(out).toMatchObject({
      totalCreated: 0,
      totalResolved: 0,
      net: 0,
      verdict: "steady",
      wip: 0,
      hasTrend: false,
    });
  });

  it("treats empty trend as zeros + hasTrend false", () => {
    const out = flowSummary([], []);
    expect(out.hasTrend).toBe(false);
    expect(out.net).toBe(0);
    expect(out.verdict).toBe("steady");
  });

  it("sums buckets and reports growing when net > 0", () => {
    const out = flowSummary([bucket("2026-01-01", 5, 2), bucket("2026-01-02", 3, 1)], []);
    expect(out.totalCreated).toBe(8);
    expect(out.totalResolved).toBe(3);
    expect(out.net).toBe(5);
    expect(out.verdict).toBe("growing");
    expect(out.hasTrend).toBe(true);
  });

  it("reports shrinking when net < 0", () => {
    const out = flowSummary([bucket("2026-01-01", 1, 4)], []);
    expect(out.net).toBe(-3);
    expect(out.verdict).toBe("shrinking");
  });

  it("reports steady when created equals resolved", () => {
    const out = flowSummary([bucket("2026-01-01", 4, 4)], []);
    expect(out.net).toBe(0);
    expect(out.verdict).toBe("steady");
  });

  it("counts only in-flight rows (active|blocked) as WIP", () => {
    const rows = [
      row({ issueKey: "A", status: "active" }),
      row({ issueKey: "B", status: "blocked" }),
      row({ issueKey: "C", status: "stalled" }),
      row({ issueKey: "D", status: "ready-to-close" }),
      row({ issueKey: "E", status: "resolved" }),
    ];
    expect(flowSummary(undefined, rows).wip).toBe(2);
  });
});

describe("mapRecommendationToAction", () => {
  it("maps every recommendation branch", () => {
    expect(mapRecommendationToAction("escalate")).toBe("promote");
    expect(mapRecommendationToAction("schedule")).toBe("schedule");
    expect(mapRecommendationToAction("close")).toBe("decline");
    expect(mapRecommendationToAction("ping-reporter")).toBe("needs-spec");
    expect(mapRecommendationToAction("ping-assignee")).toBe("needs-spec");
    expect(mapRecommendationToAction("continue")).toBe("review");
  });
});

describe("decisionsNeeded", () => {
  it("returns empty for empty input", () => {
    expect(decisionsNeeded([])).toEqual([]);
  });

  it("excludes resolved rows", () => {
    const rows = [
      row({ issueKey: "A", status: "resolved" }),
      row({ issueKey: "B", status: "active" }),
    ];
    const out = decisionsNeeded(rows);
    expect(out.map((d) => d.issueKey)).toEqual(["B"]);
  });

  it("scores demand + value and boosts actionable recommendations by +5", () => {
    const rows = [
      // base 10, +5 escalate = 15
      row({ issueKey: "ESC", temperatureScore: 5, severityScore: 5, recommendation: "escalate" }),
      // base 12, no boost = 12
      row({ issueKey: "CONT", temperatureScore: 6, severityScore: 6, recommendation: "continue" }),
    ];
    const out = decisionsNeeded(rows);
    expect(out.map((d) => d.issueKey)).toEqual(["ESC", "CONT"]);
    expect(out[0].action).toBe("promote");
    expect(out[0].demand).toBe(5);
    expect(out[0].value).toBe(5);
  });

  it("gives blocked rows the unblock action and a +3 boost", () => {
    const rows = [
      // blocked: base 8 + 3 = 11
      row({ issueKey: "BLK", temperatureScore: 4, severityScore: 4, status: "blocked", recommendation: "continue" }),
      // base 10, no boost
      row({ issueKey: "ACT", temperatureScore: 5, severityScore: 5, status: "active", recommendation: "continue" }),
    ];
    const out = decisionsNeeded(rows);
    expect(out.map((d) => d.issueKey)).toEqual(["BLK", "ACT"]);
    expect(out[0].action).toBe("unblock");
  });

  it("breaks score ties by issueKey ascending", () => {
    const rows = [
      row({ issueKey: "Z", temperatureScore: 5, severityScore: 5, recommendation: "continue" }),
      row({ issueKey: "A", temperatureScore: 5, severityScore: 5, recommendation: "continue" }),
      row({ issueKey: "M", temperatureScore: 5, severityScore: 5, recommendation: "continue" }),
    ];
    expect(decisionsNeeded(rows).map((d) => d.issueKey)).toEqual(["A", "M", "Z"]);
  });

  it("respects the limit", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      row({ issueKey: `T-${String(i).padStart(2, "0")}` }),
    );
    expect(decisionsNeeded(rows).length).toBe(8);
    expect(decisionsNeeded(rows, 3).length).toBe(3);
  });

  it("carries nextStep and rationale through", () => {
    const out = decisionsNeeded([row({ issueKey: "A", nextStep: "do thing", rationale: "because" })]);
    expect(out[0].nextStep).toBe("do thing");
    expect(out[0].rationale).toBe("because");
  });
});

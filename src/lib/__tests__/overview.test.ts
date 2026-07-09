import { describe, it, expect } from "vitest";
import { buildOverview, type ScopeInput } from "../overview-core";
import type { JiraIssue, TicketAnalysis, TriageReport } from "@/types/triage";

function issue(key: string, over: Partial<JiraIssue> = {}): JiraIssue {
  return {
    key,
    summary: `summary ${key}`,
    status: "Backlog",
    statusCategory: "new",
    priority: "P1",
    issueType: "Bug",
    reporter: null,
    assignee: "Dev A",
    created: "2026-01-01T00:00:00.000Z", // old → past SLA for P1 (28d)
    updated: "2026-06-01T00:00:00.000Z",
    resolved: null,
    labels: [],
    components: [],
    url: `https://jira/browse/${key}`,
    description: null,
    comments: [],
    parent: null,
    customers: [],
    targetedMonth: null,
    ...over,
  };
}

function analysis(key: string, over: Partial<TicketAnalysis> = {}): TicketAnalysis {
  return {
    issueKey: key,
    severityScore: 5,
    temperature: "warm",
    temperatureScore: 5,
    customer: null,
    isP0Customer: false,
    status: "active",
    daysSinceUpdate: 10,
    recommendation: "continue",
    rationale: "",
    nextStep: "",
    suggestedSprint: 1,
    evidenceQuotes: [],
    ...over,
  };
}

function report(analyses: TicketAnalysis[], over: Partial<TriageReport> = {}): TriageReport {
  return {
    generatedAt: "2026-06-01T00:00:00.000Z",
    p0Summaries: [],
    ticketAnalyses: analyses,
    closeCandidates: [],
    pingCandidates: [],
    ...over,
  };
}

const NOW = "2026-07-01T00:00:00.000Z";

function input(over: Partial<ScopeInput>): ScopeInput {
  return {
    scope: "alldefects",
    label: "All Defects",
    href: "/all-defects",
    hasP0: false,
    slaApplies: true,
    jiraBaseUrl: "https://jira",
    report: null,
    issues: [],
    ...over,
  };
}

describe("buildOverview", () => {
  it("marks an unsynced scope and yields no actions for it", () => {
    const ov = buildOverview([input({ report: null })], NOW);
    expect(ov.scopes[0].synced).toBe(false);
    expect(ov.actions).toHaveLength(0);
  });

  it("excludes done-status tickets from counts and actions", () => {
    const issues = [issue("EAC-1", { statusCategory: "done", status: "Closed" })];
    const ov = buildOverview(
      [input({ issues, report: report([analysis("EAC-1", { recommendation: "escalate" })]) })],
      NOW,
    );
    expect(ov.scopes[0].open).toBe(0);
    expect(ov.actions).toHaveLength(0);
  });

  it("picks one action per ticket by precedence (escalate > sla > ping > close)", () => {
    const issues = [issue("EAC-1")]; // old P1 → late
    const ov = buildOverview(
      [
        input({
          issues,
          report: report([analysis("EAC-1", { recommendation: "escalate" })], {
            closeCandidates: ["EAC-1"],
            pingCandidates: [{ issueKey: "EAC-1", target: "assignee" }],
          }),
        }),
      ],
      NOW,
    );
    expect(ov.actions).toHaveLength(1);
    expect(ov.actions[0].kind).toBe("escalate");
  });

  it("classifies a non-escalated, past-SLA ticket as sla", () => {
    const ov = buildOverview(
      [input({ issues: [issue("EAC-2")], report: report([analysis("EAC-2")]) })],
      NOW,
    );
    expect(ov.actions[0].kind).toBe("sla");
    expect(ov.scopes[0].pastSla).toBe(1);
  });

  it("ranks white-glove + high priority above the rest and sorts desc", () => {
    const issues = [
      issue("A-1", { priority: "P2", created: NOW }), // fresh P2, ping
      issue("A-2", { priority: "P0", created: NOW }), // fresh P0, escalate + WG
    ];
    const ov = buildOverview(
      [
        input({
          issues,
          report: report(
            [
              analysis("A-1"),
              analysis("A-2", { recommendation: "escalate", isP0Customer: true }),
            ],
            { pingCandidates: [{ issueKey: "A-1", target: "assignee" }] },
          ),
        }),
      ],
      NOW,
    );
    expect(ov.actions[0].issueKey).toBe("A-2");
    expect(ov.actions[0].rank).toBeGreaterThan(ov.actions[1].rank);
  });
});

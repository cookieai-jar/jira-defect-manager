import { describe, it, expect } from "vitest";
import {
  themeClusters,
  themeKey,
  customerConcentration,
  triageCoverage,
  possibleDuplicates,
  titleTokens,
  type DemandRow,
} from "@/lib/fr-demand";
import type { JiraIssue, TicketAnalysis } from "@/types/triage";

// --- minimal inline fixtures ------------------------------------------------

function issue(over: Partial<JiraIssue> = {}): JiraIssue {
  return {
    key: "FR-0",
    summary: "summary",
    status: "Open",
    statusCategory: "new",
    priority: null,
    issueType: "Story",
    reporter: null,
    assignee: null,
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
    resolved: null,
    labels: [],
    components: [],
    url: "https://example/FR-0",
    description: null,
    comments: [],
    parent: null,
    ...over,
  };
}

function row(
  over: Partial<TicketAnalysis> & { issue?: Partial<JiraIssue> } = {},
): DemandRow {
  const { issue: issueOver, ...analysisOver } = over;
  const key = analysisOver.issueKey ?? "FR-0";
  const analysis: TicketAnalysis = {
    issueKey: key,
    severityScore: 5,
    temperature: "warm",
    temperatureScore: 5,
    customer: null,
    isP0Customer: false,
    status: "active",
    daysSinceUpdate: 0,
    recommendation: "continue",
    rationale: "",
    nextStep: "",
    suggestedSprint: null,
    evidenceQuotes: [],
    ...analysisOver,
  };
  return { ...analysis, issue: issue({ key, ...issueOver }) };
}

// --- themeClusters ----------------------------------------------------------

describe("themeKey fallback order", () => {
  it("prefers components[0] over everything", () => {
    expect(
      themeKey(
        row({
          issue: {
            components: ["Sync"],
            labels: ["auth"],
            parent: { key: "E-1", summary: "Epic Title", type: "Epic" },
          },
        }),
      ),
    ).toBe("Sync");
  });

  it("falls back to labels[0] when no components", () => {
    expect(
      themeKey(
        row({
          issue: {
            components: [],
            labels: ["auth"],
            parent: { key: "E-1", summary: "Epic Title", type: "Epic" },
          },
        }),
      ),
    ).toBe("auth");
  });

  it("falls back to epic summary only when parent is an Epic", () => {
    expect(
      themeKey(
        row({
          issue: { parent: { key: "E-1", summary: "Epic Title", type: "Epic" } },
        }),
      ),
    ).toBe("Epic Title");
    // non-epic parent is ignored -> Uncategorized
    expect(
      themeKey(
        row({
          issue: { parent: { key: "S-1", summary: "Story Parent", type: "Story" } },
        }),
      ),
    ).toBe("Uncategorized");
  });

  it("falls back to Uncategorized with nothing", () => {
    expect(themeKey(row())).toBe("Uncategorized");
  });
});

describe("themeClusters", () => {
  it("groups, averages with 1dp rounding, excludes resolved, sorts", () => {
    const rows: DemandRow[] = [
      // Sync theme: two rows
      row({ issueKey: "A", temperatureScore: 8, severityScore: 7, issue: { components: ["Sync"] } }),
      row({ issueKey: "B", temperatureScore: 5, severityScore: 6, issue: { components: ["Sync"] } }),
      // Auth theme: one row
      row({ issueKey: "C", temperatureScore: 9, severityScore: 9, issue: { labels: ["auth"] } }),
      // resolved -> excluded
      row({ issueKey: "D", status: "resolved", issue: { components: ["Sync"] } }),
    ];
    const out = themeClusters(rows);
    expect(out.map((c) => c.theme)).toEqual(["Sync", "auth"]); // Sync count 2 first
    const sync = out[0];
    expect(sync.count).toBe(2);
    expect(sync.keys).toEqual(["A", "B"]); // D excluded
    expect(sync.avgDemand).toBe(6.5); // (8+5)/2
    expect(sync.avgValue).toBe(6.5); // (7+6)/2
    expect(out[1].avgDemand).toBe(9);
  });

  it("breaks count ties by avgDemand desc", () => {
    const rows: DemandRow[] = [
      row({ issueKey: "A", temperatureScore: 3, issue: { components: ["X"] } }),
      row({ issueKey: "B", temperatureScore: 9, issue: { components: ["Y"] } }),
    ];
    const out = themeClusters(rows);
    expect(out.map((c) => c.theme)).toEqual(["Y", "X"]);
  });

  it("rounds an average to one decimal place", () => {
    const rows: DemandRow[] = [
      row({ issueKey: "A", temperatureScore: 1, issue: { components: ["X"] } }),
      row({ issueKey: "B", temperatureScore: 1, issue: { components: ["X"] } }),
      row({ issueKey: "C", temperatureScore: 2, issue: { components: ["X"] } }),
    ];
    // (1+1+2)/3 = 1.333... -> 1.3
    expect(themeClusters(rows)[0].avgDemand).toBe(1.3);
  });
});

// --- customerConcentration --------------------------------------------------

describe("customerConcentration", () => {
  it("counts per customer, skips null/empty, flags white-glove, sorts, distinct", () => {
    const rows: DemandRow[] = [
      row({ issueKey: "A", customer: "Acme" }),
      row({ issueKey: "B", customer: "Acme", isP0Customer: true }),
      row({ issueKey: "C", customer: "Beta" }),
      row({ issueKey: "D", customer: null }),
      row({ issueKey: "E", customer: "" }),
      row({ issueKey: "F", status: "resolved", customer: "Acme" }), // excluded
    ];
    const out = customerConcentration(rows);
    expect(out.distinctCustomers).toBe(2);
    expect(out.entries.map((e) => e.customer)).toEqual(["Acme", "Beta"]);
    expect(out.topCustomer?.customer).toBe("Acme");
    expect(out.topCustomer?.count).toBe(2); // resolved F excluded
    expect(out.topCustomer?.keys).toEqual(["A", "B"]);
    expect(out.entries[0].isWhiteGlove).toBe(true); // B is P0
    expect(out.entries[1].isWhiteGlove).toBe(false);
  });

  it("returns empty shape for no customers", () => {
    const out = customerConcentration([row({ customer: null })]);
    expect(out.entries).toEqual([]);
    expect(out.distinctCustomers).toBe(0);
    expect(out.topCustomer).toBeNull();
  });
});

// --- triageCoverage ---------------------------------------------------------

describe("triageCoverage", () => {
  it("treats assigned OR slotted as triaged; only open counts", () => {
    const rows: DemandRow[] = [
      // untriaged: no assignee, no sprint
      row({ issueKey: "A", suggestedSprint: null, issue: { assignee: null } }),
      // triaged via assignee
      row({ issueKey: "B", suggestedSprint: null, issue: { assignee: "ricky" } }),
      // triaged via sprint slot
      row({ issueKey: "C", suggestedSprint: 1, issue: { assignee: null } }),
      // resolved -> excluded from total entirely
      row({ issueKey: "D", status: "resolved", suggestedSprint: null, issue: { assignee: null } }),
    ];
    const out = triageCoverage(rows);
    expect(out.total).toBe(3);
    expect(out.untriaged).toBe(1);
    expect(out.triaged).toBe(2);
    expect(out.untriagedRows.map((r) => r.issueKey)).toEqual(["A"]);
    expect(out.coveragePct).toBe(67); // 2/3 = 66.6.. -> 67
  });

  it("returns 0% coverage and 0 totals for empty / all-resolved input", () => {
    const empty = triageCoverage([]);
    expect(empty).toMatchObject({ total: 0, untriaged: 0, triaged: 0, coveragePct: 0 });
    const allResolved = triageCoverage([row({ status: "resolved" })]);
    expect(allResolved.coveragePct).toBe(0);
    expect(allResolved.total).toBe(0);
  });
});

// --- possibleDuplicates -----------------------------------------------------

describe("titleTokens", () => {
  it("lowercases, drops short tokens and stopwords", () => {
    const t = titleTokens("The SCIM sync is not working for Okta");
    // "the","is","not","for" stopwords/short dropped; "scim","sync","working","okta" kept
    expect([...t].sort()).toEqual(["okta", "scim", "sync", "working"]);
  });
});

describe("possibleDuplicates", () => {
  it("clusters near-identical titles, excludes singletons", () => {
    const rows: DemandRow[] = [
      row({ issueKey: "A", issue: { summary: "SCIM sync failing for Okta users" } }),
      row({ issueKey: "B", issue: { summary: "SCIM sync failing Okta users" } }),
      row({ issueKey: "C", issue: { summary: "Add dark mode to dashboard settings" } }),
    ];
    const out = possibleDuplicates(rows);
    expect(out).toHaveLength(1);
    expect(out[0].keys).toEqual(["A", "B"]);
    expect(out[0].sampleSummary).toBe("SCIM sync failing for Okta users");
  });

  it("does not cluster dissimilar titles", () => {
    const rows: DemandRow[] = [
      row({ issueKey: "A", issue: { summary: "SCIM sync failing for Okta" } }),
      row({ issueKey: "B", issue: { summary: "Export report to CSV format" } }),
    ];
    expect(possibleDuplicates(rows)).toEqual([]);
  });

  it("ignores stopwords / short tokens when judging similarity", () => {
    // Differ only by stopwords + short tokens -> identical meaningful sets.
    const rows: DemandRow[] = [
      row({ issueKey: "A", issue: { summary: "the connector throttling issue" } }),
      row({ issueKey: "B", issue: { summary: "connector throttling issue is not ok" } }),
    ];
    const out = possibleDuplicates(rows);
    expect(out).toHaveLength(1);
    expect(out[0].keys).toEqual(["A", "B"]);
  });

  it("excludes resolved rows and returns empty for empty input", () => {
    expect(possibleDuplicates([])).toEqual([]);
    const rows: DemandRow[] = [
      row({ issueKey: "A", issue: { summary: "duplicate connector throttling issue" } }),
      row({ issueKey: "B", status: "resolved", issue: { summary: "duplicate connector throttling issue" } }),
    ];
    // Only one open row -> singleton -> no cluster.
    expect(possibleDuplicates(rows)).toEqual([]);
  });
});

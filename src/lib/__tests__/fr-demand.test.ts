import { describe, it, expect } from "vitest";
import {
  themeClusters,
  themeTags,
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
    customers: [],
    targetedMonth: null,
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

describe("themeTags multi-tag derivation", () => {
  it("unions all components and all labels, de-duped and trimmed", () => {
    expect(
      themeTags(
        row({
          issue: {
            components: ["Sync", " Auth "],
            labels: ["auth", "Sync", "okta", "  "],
          },
        }),
      ),
      // " Auth " trims to "Auth" (distinct from label "auth"); "Sync" deduped;
      // empty/whitespace dropped.
    ).toEqual(["Sync", "Auth", "auth", "okta"]);
  });

  it("returns Uncategorized when a row has no components and no labels", () => {
    expect(themeTags(row())).toEqual(["Uncategorized"]);
    expect(themeTags(row({ issue: { components: [], labels: ["  "] } }))).toEqual([
      "Uncategorized",
    ]);
  });
});

describe("themeClusters", () => {
  it("a row appears under every tag it carries (2 components + 1 label -> 3 themes)", () => {
    const rows: DemandRow[] = [
      row({ issueKey: "A", issue: { components: ["Sync", "Auth"], labels: ["okta"] } }),
    ];
    const out = themeClusters(rows);
    expect(out.openTotal).toBe(1);
    expect(out.themes.map((t) => t.theme).sort()).toEqual(["Auth", "Sync", "okta"]);
    // each theme has the single row -> count 1, share 1
    for (const t of out.themes) {
      expect(t.count).toBe(1);
      expect(t.keys).toEqual(["A"]);
      expect(t.share).toBe(1);
    }
  });

  it("groups, averages with 1dp rounding, excludes resolved, sorts, share/openTotal", () => {
    const rows: DemandRow[] = [
      // Sync theme: two rows
      row({ issueKey: "A", temperatureScore: 8, severityScore: 7, issue: { components: ["Sync"] } }),
      row({ issueKey: "B", temperatureScore: 5, severityScore: 6, issue: { components: ["Sync"] } }),
      // Auth theme: one row (via label)
      row({ issueKey: "C", temperatureScore: 9, severityScore: 9, issue: { labels: ["auth"] } }),
      // resolved -> excluded
      row({ issueKey: "D", status: "resolved", issue: { components: ["Sync"] } }),
    ];
    const out = themeClusters(rows);
    expect(out.openTotal).toBe(3);
    expect(out.uncategorizedCount).toBe(0);
    expect(out.themes.map((c) => c.theme)).toEqual(["Sync", "auth"]); // Sync count 2 first
    const sync = out.themes[0];
    expect(sync.count).toBe(2);
    expect(sync.keys).toEqual(["A", "B"]); // D excluded
    expect(sync.avgDemand).toBe(6.5); // (8+5)/2
    expect(sync.avgValue).toBe(6.5); // (7+6)/2
    expect(sync.share).toBeCloseTo(2 / 3, 5);
    expect(out.themes[1].avgDemand).toBe(9);
    expect(out.themes[1].share).toBeCloseTo(1 / 3, 5);
  });

  it("counts a no-tag open row as Uncategorized", () => {
    const rows: DemandRow[] = [
      row({ issueKey: "A", issue: { components: ["Sync"] } }),
      row({ issueKey: "B" }), // no tags
    ];
    const out = themeClusters(rows);
    expect(out.openTotal).toBe(2);
    expect(out.uncategorizedCount).toBe(1);
    const unc = out.themes.find((t) => t.theme === "Uncategorized");
    expect(unc?.count).toBe(1);
    expect(unc?.keys).toEqual(["B"]);
  });

  it("flags tooGeneric when share > 0.4", () => {
    const rows: DemandRow[] = [
      row({ issueKey: "A", issue: { components: ["Common"] } }),
      row({ issueKey: "B", issue: { components: ["Common"] } }),
      row({ issueKey: "C", issue: { components: ["Common", "Rare"] } }),
      row({ issueKey: "D", issue: { components: ["Niche"] } }),
      row({ issueKey: "E", issue: { components: ["Niche"] } }),
    ];
    const out = themeClusters(rows);
    const common = out.themes.find((t) => t.theme === "Common");
    const rare = out.themes.find((t) => t.theme === "Rare");
    expect(common?.count).toBe(3); // 3/5 = 0.6 > 0.4
    expect(common?.tooGeneric).toBe(true);
    expect(rare?.count).toBe(1); // 1/5 = 0.2
    expect(rare?.tooGeneric).toBe(false);
  });

  it("breaks count ties by avgDemand desc", () => {
    const rows: DemandRow[] = [
      row({ issueKey: "A", temperatureScore: 3, issue: { components: ["X"] } }),
      row({ issueKey: "B", temperatureScore: 9, issue: { components: ["Y"] } }),
    ];
    const out = themeClusters(rows);
    expect(out.themes.map((c) => c.theme)).toEqual(["Y", "X"]);
  });

  it("rounds an average to one decimal place", () => {
    const rows: DemandRow[] = [
      row({ issueKey: "A", temperatureScore: 1, issue: { components: ["X"] } }),
      row({ issueKey: "B", temperatureScore: 1, issue: { components: ["X"] } }),
      row({ issueKey: "C", temperatureScore: 2, issue: { components: ["X"] } }),
    ];
    // (1+1+2)/3 = 1.333... -> 1.3
    expect(themeClusters(rows).themes[0].avgDemand).toBe(1.3);
  });

  it("returns empty themes and zero totals for no open rows", () => {
    const out = themeClusters([row({ status: "resolved" })]);
    expect(out.themes).toEqual([]);
    expect(out.openTotal).toBe(0);
    expect(out.uncategorizedCount).toBe(0);
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
  it("counts only assignee as triaged; suggestedSprint is irrelevant", () => {
    const rows: DemandRow[] = [
      // untriaged: no assignee (AI sprint suggestion does NOT triage it)
      row({ issueKey: "A", suggestedSprint: 1, issue: { assignee: null } }),
      // untriaged: no assignee, no sprint
      row({ issueKey: "B", suggestedSprint: null, issue: { assignee: null } }),
      // triaged via assignee (even with no sprint)
      row({ issueKey: "C", suggestedSprint: null, issue: { assignee: "ricky" } }),
      // resolved -> excluded from total entirely
      row({ issueKey: "D", status: "resolved", issue: { assignee: null } }),
    ];
    const out = triageCoverage(rows);
    expect(out.total).toBe(3);
    expect(out.untriaged).toBe(2); // A and B — both unassigned regardless of sprint
    expect(out.triaged).toBe(1);
    expect(out.untriagedRows.map((r) => r.issueKey)).toEqual(["A", "B"]);
    expect(out.coveragePct).toBe(33); // 1/3 = 33.3.. -> 33
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

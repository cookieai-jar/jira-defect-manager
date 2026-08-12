import { describe, it, expect } from "vitest";
import type { JiraIssue } from "@/types/triage";
import type { CodeCorrelation, DefectGroup, DefectSignal, FixCommit } from "@/types/product-defects";
import { buildCorrelation, isTestFile, ownerLookup, parseCodeowners } from "@/lib/code-correlation";
import {
  buildComponentAnalyses,
  componentCounts,
  componentSlug,
  qualifyingComponents,
} from "@/lib/component-analysis";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** Fixed clock: every metric series below is deterministic against this. */
const NOW = new Date("2026-06-15T12:00:00.000Z");

function makeIssue(key: string, over: Partial<JiraIssue> = {}): JiraIssue {
  return {
    key,
    summary: `Summary for ${key}`,
    status: "Open",
    statusCategory: "indeterminate",
    priority: "P2",
    issueType: "Bug",
    reporter: "alice",
    assignee: "bob",
    created: "2026-01-10T00:00:00.000Z",
    updated: "2026-02-01T00:00:00.000Z",
    resolved: null,
    labels: [],
    components: [],
    url: `https://jira.example/browse/${key}`,
    description: "desc",
    comments: [],
    parent: null,
    customers: ["Acme"],
    targetedMonth: null,
    ...over,
  };
}

function makeSignal(key: string, over: Partial<DefectSignal> = {}): DefectSignal {
  return {
    issueKey: key,
    area: "Okta connector",
    failureMode: "Pagination cursor expiry",
    symptom: `Symptom ${key}`,
    suspectedRootCause: "Cursor persisted before commit",
    triggerCondition: "tenant with >200k groups",
    trigger: "data-scale",
    escapeReason: "Fixtures only cover one page",
    detectionStage: "integration-test",
    errorSignatures: [],
    category: "Data ingestion correctness",
    subCategory: "Pagination & cursors",
    isRegression: false,
    customerImpact: "Stale entitlements",
    severityScore: 6,
    preventability: 5,
    ...over,
  };
}

function makeGroup(key: string, name: string, issueKeys: string[]): DefectGroup {
  return {
    key,
    name,
    description: `${name} description`,
    issueKeys,
    ticketCount: issueKeys.length,
    share: 0,
    subGroups: [],
    rootCauses: [],
    analysis: "",
    escapeAnalysis: "",
    topAreas: [],
    detectionStages: [],
    triggers: [],
    severityAvg: 0,
    preventabilityAvg: 0,
    regressionCount: 0,
    exampleQuotes: [],
  };
}

function commit(sha: string, files: string[]): FixCommit {
  return {
    sha,
    subject: `${sha}: fix`,
    date: "2026-03-01",
    files,
    touchesTests: files.some(isTestFile),
  };
}

/**
 * The shared population. Six defects, two of them carrying TWO components and
 * one carrying none — the three shapes every assertion below turns on.
 *
 *   EAC-1  Integrations
 *   EAC-2  Integrations + Graph
 *   EAC-3  Integrations
 *   EAC-4  Integrations + Graph
 *   EAC-5  (no component)
 *   EAC-6  Graph
 *
 * => Integrations 4, Graph 3, population 6.
 */
const ISSUES: JiraIssue[] = [
  makeIssue("EAC-1", { components: ["Integrations"], created: "2026-01-10T00:00:00.000Z" }),
  makeIssue("EAC-2", {
    components: ["Integrations", "Graph"],
    created: "2026-02-10T00:00:00.000Z",
  }),
  makeIssue("EAC-3", { components: ["Integrations"], created: "2026-03-10T00:00:00.000Z" }),
  makeIssue("EAC-4", {
    components: ["Integrations", "Graph"],
    created: "2026-04-10T00:00:00.000Z",
  }),
  makeIssue("EAC-5", { components: [], created: "2026-05-10T00:00:00.000Z" }),
  makeIssue("EAC-6", { components: ["Graph"], created: "2026-05-20T00:00:00.000Z" }),
];

const SIGNALS: DefectSignal[] = [
  makeSignal("EAC-1", {
    severityScore: 6,
    preventability: 5,
    detectionStage: "unit-test",
    trigger: "data-scale",
    area: "Okta connector",
    failureMode: "Pagination cursor expiry",
  }),
  makeSignal("EAC-2", {
    severityScore: 7,
    preventability: 5,
    detectionStage: "integration-test",
    trigger: "data-shape",
    area: "Okta connector",
    failureMode: "Schema drift",
  }),
  makeSignal("EAC-3", {
    severityScore: 8,
    preventability: 6,
    detectionStage: "code-review",
    trigger: "data-scale",
    area: "AD connector",
    failureMode: "Pagination cursor expiry",
  }),
  makeSignal("EAC-4", {
    severityScore: 8,
    preventability: 7,
    detectionStage: "code-review",
    trigger: "concurrency",
    isRegression: true,
    area: "Graph query",
    failureMode: "Plan cache staleness",
  }),
  makeSignal("EAC-5", {
    severityScore: 3,
    preventability: 3,
    detectionStage: "manual-qa",
    trigger: "unknown",
    area: "Access review",
    failureMode: "Export truncation",
  }),
  makeSignal("EAC-6", {
    severityScore: 5,
    preventability: 4,
    detectionStage: "e2e-test",
    trigger: "edge-case-logic",
    area: "Graph query",
    failureMode: "Plan cache staleness",
  }),
];

/** A partition of the population — as the parent report's taxonomy always is. */
const GROUPS: DefectGroup[] = [
  makeGroup("data-ingestion", "Data ingestion correctness", ["EAC-1", "EAC-2"]),
  makeGroup("graph-queries", "Graph query correctness", ["EAC-3", "EAC-4", "EAC-6"]),
  makeGroup("auth-tokens", "Auth & tokens", ["EAC-5"]),
];

/**
 * Parent correlation: 4 of 6 tickets linked, 2 fixes with tests and 2 without.
 * Deliberately arranged so every component's recomputed numbers differ from it.
 */
const PARENT_CORRELATION: CodeCorrelation = buildCorrelation({
  repoPath: "/repos/cookieai-core",
  repoHead: "deadbeef",
  allIssueKeys: ISSUES.map((i) => i.key),
  links: [
    {
      issueKey: "EAC-1",
      commits: [commit("c1", ["src/ingest/page.go", "src/ingest/page_test.go"])],
      teams: ["@org/integrations"],
      files: ["src/ingest/page.go", "src/ingest/page_test.go"],
    },
    {
      issueKey: "EAC-2",
      commits: [commit("c2", ["src/ingest/schema.go"])],
      teams: ["@org/integrations"],
      files: ["src/ingest/schema.go"],
    },
    {
      issueKey: "EAC-3",
      commits: [commit("c3", ["src/ingest/retry.go", "src/ingest/retry_test.go"])],
      teams: ["@org/integrations"],
      files: ["src/ingest/retry.go", "src/ingest/retry_test.go"],
    },
    {
      issueKey: "EAC-6",
      commits: [commit("c4", ["src/graph/plan.go"])],
      teams: ["@org/graph"],
      files: ["src/graph/plan.go"],
    },
  ],
});

function analyses(over: Partial<Parameters<typeof buildComponentAnalyses>[0]> = {}) {
  return buildComponentAnalyses({
    issues: ISSUES,
    signals: SIGNALS,
    groups: GROUPS,
    correlation: PARENT_CORRELATION,
    minDefects: 3,
    now: NOW,
    ...over,
  });
}

// ---------------------------------------------------------------------------
// componentCounts
// ---------------------------------------------------------------------------

describe("componentCounts", () => {
  it("counts a multi-component defect once under EVERY component it carries", () => {
    expect(componentCounts(ISSUES)).toEqual([
      { component: "Integrations", count: 4 },
      { component: "Graph", count: 3 },
    ]);
  });

  it("sums to MORE than the population, because components are tags not a partition", () => {
    const total = componentCounts(ISSUES).reduce((n, c) => n + c.count, 0);
    // 4 + 3 = 7 tags over 6 defects: two defects carry two components each, and
    // one carries none. This is correct behaviour, not double counting.
    expect(total).toBe(7);
    expect(total).toBeGreaterThan(ISSUES.length);
  });

  it("gives a defect with no components no component at all", () => {
    const only = componentCounts([makeIssue("EAC-9", { components: [] })]);
    expect(only).toEqual([]);
  });

  it("ignores blank component strings and a component repeated on one ticket", () => {
    const counts = componentCounts([
      makeIssue("EAC-9", { components: ["Graph", "Graph", "  ", ""] }),
    ]);
    expect(counts).toEqual([{ component: "Graph", count: 1 }]);
  });

  it("matches component names EXACTLY — case and spacing are not normalised", () => {
    const counts = componentCounts([
      makeIssue("EAC-1", { components: ["Graph"] }),
      makeIssue("EAC-2", { components: ["graph"] }),
      makeIssue("EAC-3", { components: [" Graph"] }),
    ]);
    // Three spellings, three components: a divergence in JIRA is worth seeing.
    expect(counts).toHaveLength(3);
    expect(counts.map((c) => c.count)).toEqual([1, 1, 1]);
  });

  it("breaks count ties by name so the ordering is reproducible", () => {
    const issues = [
      makeIssue("EAC-1", { components: ["Integrations"] }),
      makeIssue("EAC-2", { components: ["Graph"] }),
      makeIssue("EAC-3", { components: ["Graph"] }),
      makeIssue("EAC-4", { components: ["Integrations"] }),
    ];
    expect(componentCounts(issues).map((c) => c.component)).toEqual(["Graph", "Integrations"]);
    // Feeding the same tickets in a different order changes nothing.
    expect(componentCounts([...issues].reverse())).toEqual(componentCounts(issues));
  });
});

// ---------------------------------------------------------------------------
// qualifyingComponents
// ---------------------------------------------------------------------------

describe("qualifyingComponents", () => {
  const boundary = [
    ...Array.from({ length: 25 }, (_, i) => makeIssue(`A-${i}`, { components: ["Integrations"] })),
    ...Array.from({ length: 24 }, (_, i) => makeIssue(`B-${i}`, { components: ["Graph"] })),
  ];

  it("includes a component with EXACTLY minDefects and excludes one below it", () => {
    expect(qualifyingComponents(boundary, 25)).toEqual(["Integrations"]);
    expect(qualifyingComponents(boundary, 24)).toEqual(["Integrations", "Graph"]);
    expect(qualifyingComponents(boundary, 26)).toEqual([]);
  });

  it("defaults to a 25-defect threshold", () => {
    expect(qualifyingComponents(boundary)).toEqual(["Integrations"]);
  });

  it("treats a zero/negative threshold as 1 rather than admitting nothing", () => {
    expect(qualifyingComponents(ISSUES, 0)).toEqual(["Integrations", "Graph"]);
  });
});

// ---------------------------------------------------------------------------
// componentSlug
// ---------------------------------------------------------------------------

describe("componentSlug", () => {
  it("lowercases and hyphenates spaces and mixed case", () => {
    expect(componentSlug("Lifecycle Management")).toBe("lifecycle-management");
    expect(componentSlug("Access AI")).toBe("access-ai");
    expect(componentSlug("FrontEnd")).toBe("frontend");
    expect(componentSlug("NHI")).toBe("nhi");
    expect(componentSlug("SOD")).toBe("sod");
  });

  it("collapses runs of punctuation and trims the edges", () => {
    expect(componentSlug("  Access / Review  ")).toBe("access-review");
    expect(componentSlug("Auth & Tokens")).toBe("auth-tokens");
  });

  it("falls back rather than emitting an empty slug", () => {
    expect(componentSlug("")).toBe("uncategorized");
    expect(componentSlug("///")).toBe("uncategorized");
  });
});

// ---------------------------------------------------------------------------
// buildComponentAnalyses — shape and shares
// ---------------------------------------------------------------------------

describe("buildComponentAnalyses", () => {
  it("returns qualifying components descending by defect count", () => {
    expect(analyses().map((c) => [c.component, c.slug, c.defectCount])).toEqual([
      ["Integrations", "integrations", 4],
      ["Graph", "graph", 3],
    ]);
  });

  it("respects minDefects", () => {
    expect(analyses({ minDefects: 4 }).map((c) => c.component)).toEqual(["Integrations"]);
    expect(analyses({ minDefects: 5 })).toEqual([]);
  });

  it("leaves the three model-owned fields empty but valid", () => {
    for (const c of analyses()) {
      expect(c.summary).toBe("");
      expect(c.escapeAnalysis).toBe("");
      expect(c.strategies).toEqual([]);
    }
  });

  it("counts a multi-component defect in BOTH slices, so counts and shares overshoot", () => {
    const out = analyses();
    const integrations = out[0];
    const graph = out[1];
    expect(integrations.issueKeys).toContain("EAC-2");
    expect(graph.issueKeys).toContain("EAC-2");

    // share is a percentage of the WHOLE population: 4/6 and 3/6.
    expect(integrations.share).toBe(67);
    expect(graph.share).toBe(50);

    // Both totals exceed the population by design — asserted here so nobody
    // later "fixes" it by dividing a defect across its components.
    expect(out.reduce((n, c) => n + c.defectCount, 0)).toBe(7);
    expect(out.reduce((n, c) => n + c.defectCount, 0)).toBeGreaterThan(ISSUES.length);
    expect(out.reduce((n, c) => n + c.share, 0)).toBeGreaterThan(100);
  });

  it("puts a defect with no components in no slice at all", () => {
    const out = analyses();
    for (const c of out) expect(c.issueKeys).not.toContain("EAC-5");
    // ...and it never leaks in through a group slice either.
    for (const c of out) {
      for (const g of c.groups) expect(g.issueKeys).not.toContain("EAC-5");
    }
    // The all-EAC-5 group has no defects in any component, so it is dropped.
    for (const c of out) expect(c.groups.map((g) => g.groupKey)).not.toContain("auth-tokens");
  });

  it("does not crash on a population that is entirely component-less", () => {
    const out = buildComponentAnalyses({
      issues: [makeIssue("EAC-9", { components: [] })],
      signals: [makeSignal("EAC-9")],
      groups: GROUPS,
      minDefects: 1,
      now: NOW,
    });
    expect(out).toEqual([]);
  });

  it("uniquifies slugs when two exact-distinct names slug the same", () => {
    const issues = [
      ...Array.from({ length: 3 }, (_, i) => makeIssue(`A-${i}`, { components: ["Access AI"] })),
      ...Array.from({ length: 3 }, (_, i) => makeIssue(`B-${i}`, { components: ["Access-AI"] })),
    ];
    const out = buildComponentAnalyses({ issues, signals: [], groups: [], minDefects: 3, now: NOW });
    expect(out).toHaveLength(2);
    // Two components, two distinct routable slugs.
    expect(out.map((c) => c.slug).sort()).toEqual(["access-ai", "access-ai-2"]);
    expect(new Set(out.map((c) => c.component)).size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// buildComponentAnalyses — signal aggregates
// ---------------------------------------------------------------------------

describe("buildComponentAnalyses aggregates", () => {
  it("averages severity and preventability over the component's signals only, to 1dp", () => {
    const [integrations, graph] = analyses();
    // Integrations: severity (6+7+8+8)/4 = 7.25 -> 7.3; prev (5+5+6+7)/4 = 5.75 -> 5.8
    expect(integrations.severityAvg).toBe(7.3);
    expect(integrations.preventabilityAvg).toBe(5.8);
    // Graph: severity (7+8+5)/3 = 6.67 -> 6.7; prev (5+7+4)/3 = 5.33 -> 5.3
    expect(graph.severityAvg).toBe(6.7);
    expect(graph.preventabilityAvg).toBe(5.3);
  });

  it("yields 0 — never NaN — when the component has no signals", () => {
    const out = buildComponentAnalyses({
      issues: ISSUES,
      signals: [],
      groups: [],
      minDefects: 3,
      now: NOW,
    });
    for (const c of out) {
      expect(c.severityAvg).toBe(0);
      expect(c.preventabilityAvg).toBe(0);
      expect(Number.isNaN(c.severityAvg)).toBe(false);
      expect(Number.isNaN(c.preventabilityAvg)).toBe(false);
      expect(c.regressionCount).toBe(0);
      expect(c.detectionStages).toEqual([]);
      expect(c.triggers).toEqual([]);
      expect(c.topAreas).toEqual([]);
      expect(c.topFailureModes).toEqual([]);
      // The defect count still comes from the tickets, not from the signals.
      expect(c.defectCount).toBeGreaterThan(0);
    }
  });

  it("counts regressions within the component", () => {
    const [integrations, graph] = analyses();
    expect(integrations.regressionCount).toBe(1); // EAC-4
    expect(graph.regressionCount).toBe(1); // EAC-4 again — it is in both
  });

  it("sorts detectionStages by count, tie-broken by the enum's declared order", () => {
    const [integrations] = analyses();
    // code-review 2; then unit-test and integration-test tie at 1. The enum
    // declares unit-test BEFORE integration-test, so it wins the tie even though
    // "integration-test" sorts first alphabetically.
    expect(integrations.detectionStages).toEqual([
      { stage: "code-review", count: 2 },
      { stage: "unit-test", count: 1 },
      { stage: "integration-test", count: 1 },
    ]);
  });

  it("sorts triggers by count, tie-broken by the enum's declared order", () => {
    const [integrations] = analyses();
    // data-shape and concurrency tie at 1; DEFECT_TRIGGERS declares data-shape
    // first, which beats alphabetical order ("concurrency" < "data-shape").
    expect(integrations.triggers).toEqual([
      { trigger: "data-scale", count: 2 },
      { trigger: "data-shape", count: 1 },
      { trigger: "concurrency", count: 1 },
    ]);
  });

  it("ranks the component's top areas and failure modes", () => {
    const [integrations] = analyses();
    expect(integrations.topAreas).toEqual(["Okta connector", "AD connector", "Graph query"]);
    expect(integrations.topFailureModes).toEqual([
      "Pagination cursor expiry",
      "Plan cache staleness",
      "Schema drift",
    ]);
    // The component-less ticket's area never appears anywhere.
    for (const c of analyses()) expect(c.topAreas).not.toContain("Access review");
  });
});

// ---------------------------------------------------------------------------
// buildComponentAnalyses — group slices
// ---------------------------------------------------------------------------

describe("component group slices", () => {
  it("omits groups with zero defects in the component instead of listing them at 0", () => {
    const [integrations, graph] = analyses();
    expect(integrations.groups.map((g) => g.groupKey)).toEqual(["data-ingestion", "graph-queries"]);
    expect(graph.groups.map((g) => g.groupKey)).toEqual(["graph-queries", "data-ingestion"]);
    for (const c of analyses()) for (const g of c.groups) expect(g.ticketCount).toBeGreaterThan(0);
  });

  it("sorts slices descending by ticketCount, ties by group name", () => {
    const [integrations] = analyses();
    // Both slices hold 2 tickets; "Data ingestion correctness" wins on name.
    expect(integrations.groups.map((g) => [g.name, g.ticketCount])).toEqual([
      ["Data ingestion correctness", 2],
      ["Graph query correctness", 2],
    ]);
  });

  it("takes slice share over THE COMPONENT's defects, summing to 100 within it", () => {
    const [integrations, graph] = analyses();
    expect(integrations.groups.map((g) => g.share)).toEqual([50, 50]);
    expect(integrations.groups.reduce((n, g) => n + g.share, 0)).toBe(100);

    // Graph: 2/3 and 1/3 of the component (not of the population).
    expect(graph.groups.map((g) => [g.groupKey, g.ticketCount, g.share])).toEqual([
      ["graph-queries", 2, 67],
      ["data-ingestion", 1, 33],
    ]);
    expect(graph.groups.reduce((n, g) => n + g.share, 0)).toBe(100);

    // The two `share` fields have different denominators: EAC-2's group is 33%
    // of Graph, while Graph itself is 50% of the population.
    expect(graph.share).toBe(50);
  });

  it("scopes each slice's issue keys and distributions to the component", () => {
    const [, graph] = analyses();
    const ingestion = graph.groups.find((g) => g.groupKey === "data-ingestion");
    // The parent group holds EAC-1 and EAC-2; only EAC-2 is tagged Graph.
    expect(ingestion?.issueKeys).toEqual(["EAC-2"]);
    expect(ingestion?.detectionStages).toEqual([{ stage: "integration-test", count: 1 }]);
    expect(ingestion?.triggers).toEqual([{ trigger: "data-shape", count: 1 }]);
  });

  it("keeps slice shares at or below 100 when some defects were never classified", () => {
    // EAC-3 is in no group at all: 3 of Integrations' 4 defects are classified.
    const out = buildComponentAnalyses({
      issues: ISSUES,
      signals: SIGNALS,
      groups: [makeGroup("data-ingestion", "Data ingestion correctness", ["EAC-1", "EAC-2"])],
      minDefects: 3,
      now: NOW,
    });
    const [integrations] = out;
    expect(integrations.groups.map((g) => g.share)).toEqual([50]);
    expect(integrations.groups.reduce((n, g) => n + g.share, 0)).toBeLessThan(100);
  });
});

// ---------------------------------------------------------------------------
// buildComponentAnalyses — restricted code correlation
// ---------------------------------------------------------------------------

describe("component code correlation", () => {
  it("recomputes linkRate over the component's defects rather than inheriting it", () => {
    expect(PARENT_CORRELATION.linkedTickets).toBe(4);
    expect(PARENT_CORRELATION.totalTickets).toBe(6);
    expect(PARENT_CORRELATION.linkRate).toBe(66.7);

    const [integrations, graph] = analyses();
    // Integrations: EAC-1/2/3 linked of 4 defects.
    expect(integrations.codeCorrelation?.totalTickets).toBe(4);
    expect(integrations.codeCorrelation?.linkedTickets).toBe(3);
    expect(integrations.codeCorrelation?.linkRate).toBe(75);
    expect(integrations.codeCorrelation?.linkRate).not.toBe(PARENT_CORRELATION.linkRate);

    // Graph: EAC-2/6 linked of 3 defects.
    expect(graph.codeCorrelation?.totalTickets).toBe(3);
    expect(graph.codeCorrelation?.linkedTickets).toBe(2);
  });

  it("recomputes fixesWithTests / fixesWithoutTests for the subset", () => {
    expect(PARENT_CORRELATION.fixesWithTests).toBe(2);
    expect(PARENT_CORRELATION.fixesWithoutTests).toBe(2);

    const [integrations, graph] = analyses();
    expect(integrations.codeCorrelation?.fixesWithTests).toBe(2); // c1, c3
    expect(integrations.codeCorrelation?.fixesWithoutTests).toBe(1); // c2
    expect(graph.codeCorrelation?.fixesWithTests).toBe(0);
    expect(graph.codeCorrelation?.fixesWithoutTests).toBe(2); // c2, c4
  });

  it("recomputes per-team testChangeRate instead of copying the parent's", () => {
    const parentIntegrationsTeam = PARENT_CORRELATION.byTeam.find(
      (t) => t.team === "@org/integrations",
    );
    expect(parentIntegrationsTeam?.testChangeRate).toBe(66.7); // 2 of 3 commits

    const [, graph] = analyses();
    const graphSideTeam = graph.codeCorrelation?.byTeam.find((t) => t.team === "@org/integrations");
    // Inside Graph, that team's only linked ticket is EAC-2, whose fix shipped
    // with no test — 0%, not the parent's 66.7%.
    expect(graphSideTeam?.defectCount).toBe(1);
    expect(graphSideTeam?.commitCount).toBe(1);
    expect(graphSideTeam?.testChangeRate).toBe(0);
  });

  it("restricts links and hotspots to the component's tickets", () => {
    const [integrations, graph] = analyses();
    expect(integrations.codeCorrelation?.links.map((l) => l.issueKey)).toEqual([
      "EAC-1",
      "EAC-2",
      "EAC-3",
    ]);
    expect(graph.codeCorrelation?.links.map((l) => l.issueKey)).toEqual(["EAC-2", "EAC-6"]);

    const integrationsPaths = integrations.codeCorrelation?.fileHotspots.map((h) => h.path) ?? [];
    expect(integrationsPaths).toContain("src/ingest/schema.go");
    expect(integrationsPaths).not.toContain("src/graph/plan.go");
    expect(graph.codeCorrelation?.fileHotspots.map((h) => h.path)).toContain("src/graph/plan.go");
  });

  it("exposes the component's own teams, descending by defect count", () => {
    const [integrations, graph] = analyses();
    expect(integrations.teams.map((t) => [t.team, t.defectCount])).toEqual([
      ["@org/integrations", 3],
    ]);
    expect(integrations.teams).toEqual(integrations.codeCorrelation?.byTeam);
    expect(graph.teams.map((t) => t.defectCount)).toEqual([1, 1]);
    for (let i = 1; i < graph.teams.length; i++) {
      expect(graph.teams[i - 1].defectCount).toBeGreaterThanOrEqual(graph.teams[i].defectCount);
    }
  });

  it("carries the parent's repo identity and projects the component's groups", () => {
    const [integrations] = analyses();
    expect(integrations.codeCorrelation?.repoPath).toBe("/repos/cookieai-core");
    expect(integrations.codeCorrelation?.repoHead).toBe("deadbeef");
    expect(integrations.codeCorrelation?.byGroup.map((b) => b.groupKey)).toEqual([
      "data-ingestion",
      "graph-queries",
    ]);
  });

  it("is null for every component when the parent correlation is null", () => {
    const out = analyses({ correlation: null });
    for (const c of out) {
      expect(c.codeCorrelation).toBeNull();
      expect(c.teams).toEqual([]);
    }
    // Same when the field is simply absent.
    expect(
      buildComponentAnalyses({
        issues: ISSUES,
        signals: SIGNALS,
        groups: GROUPS,
        minDefects: 3,
        now: NOW,
      })[0].codeCorrelation,
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildComponentAnalyses — CODEOWNERS resolver
// ---------------------------------------------------------------------------

describe("component code correlation with a CODEOWNERS resolver", () => {
  // One ticket whose single fix commit spans two differently-owned trees, and
  // whose link records the UNION of both teams — exactly the shape the git layer
  // produces. Per-file attribution must give each team only its own file; the
  // ticket-level fallback hands both teams the whole file set.
  const OWNED_FILES = ["agents/okta/sync.go", "controlp/auth/token.go"];
  const owners = ownerLookup(
    parseCodeowners(
      ["/agents/ @org/integrations", "/controlp/ @org/platform-core"].join("\n"),
    ),
  );

  const issues = Array.from({ length: 3 }, (_, i) =>
    makeIssue(`LM-${i}`, { components: ["Lifecycle Management"] }),
  );
  const groups = [makeGroup("provisioning", "Provisioning", issues.map((i) => i.key))];
  const parent = buildCorrelation({
    repoPath: "/repos/cookieai-core",
    repoHead: "cafe1234",
    allIssueKeys: issues.map((i) => i.key),
    links: [
      {
        issueKey: "LM-0",
        commits: [commit("c9", OWNED_FILES)],
        teams: ["@org/integrations", "@org/platform-core"],
        files: OWNED_FILES,
      },
    ],
  });

  function run(withOwners: boolean) {
    return buildComponentAnalyses({
      issues,
      signals: issues.map((i) => makeSignal(i.key)),
      groups,
      correlation: parent,
      ...(withOwners ? { owners } : {}),
      minDefects: 3,
      now: NOW,
    })[0];
  }

  it("gives each team only the files CODEOWNERS assigns it", () => {
    const teams = run(true).teams;
    expect(teams.map((t) => [t.team, t.defectCount, t.fileCount])).toEqual([
      ["@org/integrations", 1, 1],
      ["@org/platform-core", 1, 1],
    ]);
  });

  it("falls back to the ticket-level union without a resolver, inflating file counts", () => {
    // Documented degradation, asserted so the difference is visible: both teams
    // inherit the ticket's ENTIRE file set. This is what would systematically
    // overstate broad owners on a component page.
    const teams = run(false).teams;
    expect(teams.map((t) => [t.team, t.defectCount, t.fileCount])).toEqual([
      ["@org/integrations", 1, 2],
      ["@org/platform-core", 1, 2],
    ]);
    // Same tickets either way — the fallback is coarse, never wrong about those.
    expect(run(false).codeCorrelation?.linkedTickets).toBe(
      run(true).codeCorrelation?.linkedTickets,
    );
  });

  it("threads the resolver into the component's hotspots and per-group hotspots", () => {
    const withOwners = run(true).codeCorrelation;
    const withoutOwners = run(false).codeCorrelation;
    const teamsFor = (correlation: CodeCorrelation | null | undefined, path: string) =>
      correlation?.fileHotspots.find((h) => h.path === path)?.teams;
    expect(teamsFor(withOwners, "controlp/auth/token.go")).toEqual(["@org/platform-core"]);
    expect(teamsFor(withoutOwners, "controlp/auth/token.go")).toEqual([
      "@org/integrations",
      "@org/platform-core",
    ]);

    const groupHotspot = withOwners?.byGroup[0]?.fileHotspots.find(
      (h) => h.path === "agents/okta/sync.go",
    );
    expect(groupHotspot?.teams).toEqual(["@org/integrations"]);
  });
});

// ---------------------------------------------------------------------------
// buildComponentAnalyses — metrics and determinism
// ---------------------------------------------------------------------------

describe("component metrics", () => {
  it("computes the metric series over the component's issues only", () => {
    const [integrations, graph] = analyses();
    const inflowOf = (metrics: typeof integrations.metrics) =>
      metrics
        .find((m) => m.key === "customer-defect-inflow")
        ?.series.reduce((n, p) => n + (p.value ?? 0), 0);
    // Every defect is created inside the 13-month window, so inflow sums to the
    // component's own defect count — 4 and 3, not the population's 6.
    expect(inflowOf(integrations.metrics)).toBe(4);
    expect(inflowOf(graph.metrics)).toBe(3);
  });

  it("derives escape-stage metrics from the component's own signals", () => {
    const [integrations, graph] = analyses();
    const keys = (metrics: typeof integrations.metrics) =>
      metrics.filter((m) => m.key.startsWith("escape-stage-")).map((m) => m.key);
    // unit-test only ever appears on EAC-1, which is Integrations-only.
    expect(keys(integrations.metrics)).toContain("escape-stage-unit-test");
    expect(keys(graph.metrics)).not.toContain("escape-stage-unit-test");
    // e2e-test only appears on EAC-6, which is Graph-only.
    expect(keys(graph.metrics)).toContain("escape-stage-e2e-test");
    expect(keys(integrations.metrics)).not.toContain("escape-stage-e2e-test");
  });

  it("bases the concentration metric on the component's own group slices", () => {
    const [integrations] = analyses();
    const concentration = integrations.metrics.find(
      (m) => m.key === "defect-concentration-top3",
    );
    expect(concentration?.automated).toBe(true);
    expect(concentration?.relatedGroupKeys).toEqual(["data-ingestion", "graph-queries"]);
    // The all-EAC-5 group is not part of this component and must not appear.
    expect(concentration?.relatedGroupKeys).not.toContain("auth-tokens");
  });

  it("feeds the restricted correlation to the code-side metrics", () => {
    const [graph] = [analyses()[1]];
    const fixWithTest = graph.metrics.find((m) => m.key === "fix-with-test-rate");
    expect(fixWithTest?.automated).toBe(true);
    // Graph's two linked fixes (c2, c4) both shipped without a test: 0%.
    const march = fixWithTest?.series.find((p) => p.period === "2026-03");
    expect(march?.value).toBe(0);
    expect(march?.denominator).toBe(2);
  });

  it("is byte-for-byte identical across runs given a fixed `now`", () => {
    expect(JSON.stringify(analyses())).toBe(JSON.stringify(analyses()));
    // ...and independent of the order the tickets arrive in.
    const reversed = analyses({ issues: [...ISSUES].reverse() });
    expect(reversed.map((c) => [c.component, c.defectCount, c.share, c.severityAvg])).toEqual(
      analyses().map((c) => [c.component, c.defectCount, c.share, c.severityAvg]),
    );
  });
});

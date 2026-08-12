import { describe, it, expect } from "vitest";
import type { JiraIssue } from "@/types/triage";
import type {
  CodeCorrelation,
  ComponentAnalysis,
  DefectGroup,
  DefectMetric,
  DefectSignal,
} from "@/types/product-defects";
import {
  analyzeProductDefects,
  applyComponentNarrative,
  applyGroupDeepDive,
  batchIssues,
  clamp,
  compactIssue,
  componentCodeContext,
  componentPromptPayload,
  componentStrategyKey,
  emptyProductDefectAnalysis,
  groupCodeContext,
  MAX_TOP_LEVEL_GROUPS,
  normLabel,
  normalizeAssignments,
  normalizeSignals,
  normalizeStrategyPhase,
  normalizeSynthesis,
  normalizeTeamPlans,
  oneOf,
  pct,
  REMAINDER_GROUP_NAME,
  rollupByCategory,
  slugify,
  teamLabel,
  teamOwnershipFromCorrelation,
  unplacedCategoryLabels,
  type CompletionFn,
} from "@/lib/product-defects-analysis";

// Loose alias so the stub completion can return untyped payloads.
type Any_ = unknown;

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
    created: "2026-01-01T00:00:00.000Z",
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
    preventability: 7,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("pure helpers", () => {
  it("clamp rounds and bounds", () => {
    expect(clamp(5.4, 1, 10)).toBe(5);
    expect(clamp(-3, 1, 10)).toBe(1);
    expect(clamp(99, 1, 10)).toBe(10);
    expect(clamp(NaN, 1, 10)).toBe(1);
  });

  it("slugify lowercases, hyphenates and defaults", () => {
    expect(slugify("Credential & Token Lifecycle")).toBe("credential-token-lifecycle");
    expect(slugify("  !!! ")).toBe("uncategorized");
  });

  it("pct rounds to 0-100 and guards a zero denominator", () => {
    expect(pct(1, 3)).toBe(33);
    expect(pct(3, 3)).toBe(100);
    expect(pct(1, 0)).toBe(0);
  });

  it("normLabel is case- and whitespace-insensitive", () => {
    expect(normLabel("  Pagination   & Cursors ")).toBe(normLabel("pagination & cursors"));
  });

  it("teamLabel humanizes a CODEOWNERS slug", () => {
    expect(teamLabel("@cookieai-jar/lifecycle-mgmt")).toBe("Lifecycle Mgmt");
    expect(teamLabel("Quality Engineering")).toBe("Quality Engineering");
  });

  it("oneOf falls back for off-list values", () => {
    expect(oneOf("b", ["a", "b"] as const, "a")).toBe("b");
    expect(oneOf("ZZZ", ["a", "b"] as const, "a")).toBe("a");
    expect(oneOf(42, ["a", "b"] as const, "a")).toBe("a");
  });

  it("batchIssues splits with a remainder and coerces bad sizes", () => {
    const issues = Array.from({ length: 5 }, (_, i) => makeIssue(`I-${i}`));
    expect(batchIssues(issues, 2).map((b) => b.length)).toEqual([2, 2, 1]);
    expect(batchIssues([], 8)).toEqual([]);
    expect(batchIssues(issues, 0)).toHaveLength(5);
  });

  it("compactIssue emits JSON with the key, customers and the last 4 comments", () => {
    const comments = Array.from({ length: 6 }, (_, i) => ({
      id: String(i),
      author: "u",
      body: "x".repeat(2000),
      created: `2026-01-0${i + 1}T00:00:00.000Z`,
      updated: `2026-01-0${i + 1}T00:00:00.000Z`,
    }));
    const parsed = JSON.parse(
      compactIssue(makeIssue("EAC-1", { comments, resolved: "2026-01-11T00:00:00.000Z" })),
    );
    expect(parsed.key).toBe("EAC-1");
    expect(parsed.customers).toEqual(["Acme"]);
    expect(parsed.lastComments).toHaveLength(4);
    expect(parsed.lastComments[0].body.length).toBeLessThanOrEqual(900);
    expect(parsed.daysToResolve).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Phase 1 — extraction normalization
// ---------------------------------------------------------------------------

describe("normalizeSignals", () => {
  const batch = [makeIssue("EAC-1"), makeIssue("EAC-2")];

  it("returns one signal per ticket in the batch, matched by key", () => {
    const raw = [
      {
        issueKey: "EAC-2",
        area: "Snowflake connector",
        failureMode: "Token refresh race",
        symptom: "401 after an hour",
        suspectedRootCause: "per-worker refresh",
        triggerCondition: "two syncs overlap",
        trigger: "concurrency",
        escapeReason: "no concurrent-sync test",
        detectionStage: "integration-test",
        errorSignatures: ["401 Unauthorized"],
        category: "Credential lifecycle",
        subCategory: "Token refresh",
        isRegression: true,
        customerImpact: "sync halted",
        severityScore: 8,
        preventability: 9,
      },
    ];
    const out = normalizeSignals(raw, batch);
    expect(out).toHaveLength(2);
    const s = out.find((x) => x.issueKey === "EAC-2")!;
    expect(s.area).toBe("Snowflake connector");
    expect(s.trigger).toBe("concurrency");
    expect(s.detectionStage).toBe("integration-test");
    expect(s.isRegression).toBe(true);
    expect(s.severityScore).toBe(8);
    expect(s.preventability).toBe(9);
    expect(s.subCategory).toBe("Token refresh");
  });

  it("drops entries whose issueKey is not in the batch", () => {
    const raw = [
      { issueKey: "ZZZ-999", category: "Hallucinated", severityScore: 10 },
      { issueKey: "EAC-1", category: "Real", severityScore: 3 },
    ];
    const out = normalizeSignals(raw, batch);
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.issueKey).sort()).toEqual(["EAC-1", "EAC-2"]);
    expect(out.find((s) => s.issueKey === "EAC-1")!.category).toBe("Real");
    // The phantom key contributed nothing at all.
    expect(out.some((s) => s.category === "Hallucinated")).toBe(false);
  });

  it("falls back to 'unknown'/'unclassified' for off-list enum values", () => {
    const raw = [
      {
        issueKey: "EAC-1",
        trigger: "cosmic-rays",
        detectionStage: "vibes-review",
      },
    ];
    const s = normalizeSignals(raw, batch).find((x) => x.issueKey === "EAC-1")!;
    expect(s.trigger).toBe("unknown");
    // NOT "not-preventable" — that is a deliberate model judgement, and
    // defaulting to it would inflate the "nothing could have caught it" bucket.
    expect(s.detectionStage).toBe("unclassified");
  });

  it("preserves a deliberate 'not-preventable' judgement", () => {
    const s = normalizeSignals(
      [{ issueKey: "EAC-1", detectionStage: "not-preventable" }],
      batch,
    ).find((x) => x.issueKey === "EAC-1")!;
    expect(s.detectionStage).toBe("not-preventable");
  });

  it("fills safe defaults from the ticket for anything the model omitted", () => {
    const withComponent = [makeIssue("EAC-3", { components: ["okta-connector"] })];
    const s = normalizeSignals([], withComponent)[0];
    expect(s.issueKey).toBe("EAC-3");
    expect(s.area).toBe("okta-connector"); // component is a better guess than null
    expect(s.failureMode).toBe("Unclassified");
    expect(s.symptom).toBe("Summary for EAC-3");
    expect(s.suspectedRootCause).toBe("Undetermined");
    expect(s.escapeReason).toBe("Undetermined");
    expect(s.category).toBe("Uncategorized");
    expect(s.severityScore).toBe(5);
    expect(s.preventability).toBe(5);
    expect(s.isRegression).toBe(false);
    expect(s.detectionStage).toBe("unclassified");
  });

  it("infers isRegression from a 'regression' trigger, clamps scores, caps errors", () => {
    const raw = [
      {
        issueKey: "EAC-1",
        trigger: "regression",
        isRegression: false,
        severityScore: 99,
        preventability: -4,
        errorSignatures: Array.from({ length: 20 }, (_, i) => `e${i}`),
      },
    ];
    const s = normalizeSignals(raw, batch).find((x) => x.issueKey === "EAC-1")!;
    expect(s.isRegression).toBe(true);
    expect(s.severityScore).toBe(10);
    expect(s.preventability).toBe(1);
    expect(s.errorSignatures).toHaveLength(8);
  });

  it("tolerates non-array raw input", () => {
    expect(normalizeSignals(null, batch)).toHaveLength(2);
    expect(normalizeSignals({ nope: true }, batch)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Rollups
// ---------------------------------------------------------------------------

describe("rollupByCategory", () => {
  const signals = [
    makeSignal("A-1", { category: "Ingestion", subCategory: "Pagination" }),
    makeSignal("A-2", { category: "ingestion", subCategory: "pagination", severityScore: 10 }),
    makeSignal("A-3", {
      category: "Ingestion",
      subCategory: "Schema drift",
      isRegression: true,
      preventability: 3,
    }),
    makeSignal("B-1", { category: "Scale", subCategory: "" }),
  ];

  it("groups case-insensitively with sub-category counts and derived stats", () => {
    const rollups = rollupByCategory(signals);
    expect(rollups.map((r) => r.count)).toEqual([3, 1]);
    const ingestion = rollups[0];
    expect(ingestion.category).toBe("Ingestion");
    expect(ingestion.subCategories).toEqual([
      { name: "Pagination", count: 2 },
      { name: "Schema drift", count: 1 },
    ]);
    expect(ingestion.regressionCount).toBe(1);
    expect(ingestion.detectionStages[0]).toEqual({ stage: "integration-test", count: 3 });
    expect(ingestion.triggers[0]).toEqual({ trigger: "data-scale", count: 3 });
    expect(ingestion.severityAvg).toBeCloseTo(7.3, 1);
  });

  it("caps samples per category", () => {
    const many = Array.from({ length: 20 }, (_, i) => makeSignal(`X-${i}`, { category: "Scale" }));
    const rollups = rollupByCategory(many, 5);
    expect(rollups[0].count).toBe(20);
    expect(rollups[0].samples).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Phase 2 — synthesis
// ---------------------------------------------------------------------------

describe("normalizeSynthesis", () => {
  const signals = [
    makeSignal("A-1", { category: "Ingestion", subCategory: "Pagination", severityScore: 8, preventability: 8 }),
    makeSignal("A-2", { category: "Sync", subCategory: "Pagination", severityScore: 4, preventability: 6 }),
    makeSignal("A-3", { category: "Ingestion", subCategory: "Schema drift", isRegression: true }),
    makeSignal("B-1", { category: "Scale", subCategory: "Memory", detectionStage: "scale-test", trigger: "data-scale" }),
  ];

  it("recomputes counts/shares/averages, ignoring numbers the model supplied", () => {
    const raw = {
      executiveSummary: "Escapes concentrate in integration test.",
      groups: [
        {
          name: "Data ingestion correctness",
          description: "Ingestion pipeline defects.",
          mergesCategories: ["Ingestion", "Sync"],
          // Bogus numbers the model volunteered — must be discarded.
          ticketCount: 999,
          share: 42,
          subGroups: [
            { name: "Pagination & cursors", mergesSubCategories: ["Pagination"], ticketCount: 77 },
            { name: "Schema drift", mergesSubCategories: ["Schema drift"] },
          ],
        },
      ],
    };
    const out = normalizeSynthesis(raw, signals);
    expect(out.executiveSummary).toBe("Escapes concentrate in integration test.");
    const g = out.groups.find((x) => x.key === "data-ingestion-correctness")!;
    expect(g.ticketCount).toBe(3);
    expect(g.share).toBe(75); // 3 of 4, not 42
    expect(g.issueKeys.sort()).toEqual(["A-1", "A-2", "A-3"]);
    expect(g.regressionCount).toBe(1);
    expect(g.severityAvg).toBeCloseTo(6, 1); // (8 + 4 + 6) / 3
    expect(g.detectionStages[0]).toEqual({ stage: "integration-test", count: 3 });
    // Sub-group shares are of the PARENT group, not the population.
    const pag = g.subGroups.find((s) => s.key === "pagination-cursors")!;
    expect(pag.ticketCount).toBe(2);
    expect(pag.share).toBe(67);
    expect(pag.issueKeys.sort()).toEqual(["A-1", "A-2"]);
    // Escape-analysis aggregates are emitted at sub-group granularity too.
    expect(pag.detectionStages).toEqual([{ stage: "integration-test", count: 2 }]);
    expect(pag.triggers).toEqual([{ trigger: "data-scale", count: 2 }]);
    expect(pag.severityAvg).toBe(6); // (8 + 4) / 2
    expect(pag.preventabilityAvg).toBe(7); // (8 + 6) / 2
    expect(pag.regressionCount).toBe(0);
    const drift = g.subGroups.find((s) => s.key === "schema-drift")!;
    expect(drift.regressionCount).toBe(1); // differs from its sibling
  });

  it("places every ticket in exactly one group and at most one sub-group", () => {
    const raw = {
      groups: [
        { name: "First", mergesCategories: ["Ingestion", "Sync"], subGroups: [
          { name: "Everything", mergesSubCategories: ["Pagination", "Schema drift"] },
          { name: "Duplicate claim", mergesSubCategories: ["Pagination"] },
        ] },
        // Re-claims a category the first group already took — must yield nothing.
        { name: "Second", mergesCategories: ["Ingestion"] },
      ],
    };
    const out = normalizeSynthesis(raw, signals);
    const all = out.groups.flatMap((g) => g.issueKeys);
    expect(all.sort()).toEqual(["A-1", "A-2", "A-3", "B-1"]);
    expect(new Set(all).size).toBe(all.length); // no ticket in two groups
    expect(out.groups.find((g) => g.name === "Second")).toBeUndefined(); // empty → dropped
    // "Scale" was never placed → the remainder bucket, not its own group.
    const bucket = out.groups.find((g) => g.name === REMAINDER_GROUP_NAME)!;
    expect(bucket.issueKeys).toEqual(["B-1"]);
    expect(out.groups.find((g) => g.name === "Scale")).toBeUndefined();
    const first = out.groups.find((g) => g.name === "First")!;
    const subKeys = first.subGroups.flatMap((s) => s.issueKeys);
    expect(new Set(subKeys).size).toBe(subKeys.length); // no ticket in two sub-groups
    expect(first.subGroups.find((s) => s.name === "Duplicate claim")).toBeUndefined();
  });

  it("collapses into ONE remainder bucket when synthesis returns nothing", () => {
    const out = normalizeSynthesis(null, signals);
    expect(out.executiveSummary).toBe("");
    // Not three singleton groups — one honestly-labelled bucket.
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0].name).toBe(REMAINDER_GROUP_NAME);
    expect(out.groups[0].ticketCount).toBe(4);
    expect(out.groups[0].share).toBe(100);
    expect(out.groups[0].description).toMatch(/did not merge into a named group/);
    // The count of unmerged labels is surfaced, so a weak synthesis is visible.
    expect(out.groups[0].description).toMatch(/^3 extraction categories/);
  });

  it("returns no groups for an empty signal set", () => {
    expect(normalizeSynthesis({ groups: [] }, []).groups).toEqual([]);
  });

  it("sorts groups by ticket volume and de-duplicates colliding keys", () => {
    const dupes = [
      makeSignal("D-1", { category: "Alpha" }),
      makeSignal("D-2", { category: "Alpha!" }),
      makeSignal("D-3", { category: "Beta" }),
      makeSignal("D-4", { category: "Beta" }),
      makeSignal("D-5", { category: "Beta" }),
    ];
    const out = normalizeSynthesis(
      {
        groups: [
          { name: "Alpha", mergesCategories: ["Alpha"] },
          { name: "Alpha!", mergesCategories: ["Alpha!"] },
          { name: "Beta", mergesCategories: ["Beta"] },
        ],
      },
      dupes,
    );
    expect(out.groups[0].name).toBe("Beta"); // 3 tickets first
    // "Alpha" and "Alpha!" both slugify to "alpha" — keys must stay unique.
    expect(new Set(out.groups.map((g) => g.key)).size).toBe(out.groups.length);
  });
});

describe("unplacedCategoryLabels", () => {
  const signals = [
    makeSignal("A-1", { category: "Ingestion" }),
    makeSignal("A-2", { category: "Sync" }),
    makeSignal("A-3", { category: "Sync" }),
    makeSignal("B-1", { category: "Scale" }),
  ];

  it("reports only the labels the first pass failed to claim, largest first", () => {
    const out = unplacedCategoryLabels({ groups: [{ name: "Ingestion" }] }, signals);
    expect(out.map((u) => u.label)).toEqual(["Sync", "Scale"]);
    expect(out[0].count).toBe(2);
    expect(out[0].topFailureModes).toEqual(["Pagination cursor expiry"]);
  });

  it("reports everything when synthesis produced nothing", () => {
    expect(unplacedCategoryLabels(null, signals).map((u) => u.label).sort()).toEqual([
      "Ingestion",
      "Scale",
      "Sync",
    ]);
  });
});

describe("normalizeAssignments", () => {
  it("accepts a wrapped or bare array and drops incomplete entries", () => {
    expect(normalizeAssignments({ assignments: [{ label: "Sync", group: "Ingestion" }] })).toEqual([
      { label: "Sync", group: "Ingestion" },
    ]);
    expect(normalizeAssignments([{ label: "Sync", group: "none" }])).toEqual([
      { label: "Sync", group: "none" },
    ]);
    expect(normalizeAssignments([{ label: "Sync" }, { group: "X" }, 7])).toEqual([]);
    expect(normalizeAssignments(null)).toEqual([]);
  });
});

describe("normalizeSynthesis — second-pass placement and the group ceiling", () => {
  const signals = [
    makeSignal("A-1", { category: "Ingestion" }),
    makeSignal("A-2", { category: "Sync" }),
    makeSignal("B-1", { category: "Scale" }),
    makeSignal("C-1", { category: "Weird one-off" }),
  ];
  const raw = { groups: [{ name: "Data ingestion", mergesCategories: ["Ingestion"] }] };

  it("routes second-pass assignments into the named group", () => {
    const out = normalizeSynthesis(raw, signals, {
      assignments: [
        { label: "Sync", group: "Data ingestion" },
        { label: "Scale", group: "data-ingestion" }, // slug alias also matches
        { label: "Weird one-off", group: "none" }, // explicit refusal
      ],
    });
    const g = out.groups.find((x) => x.name === "Data ingestion")!;
    expect(g.ticketCount).toBe(3);
    expect(g.issueKeys.sort()).toEqual(["A-1", "A-2", "B-1"]);
    expect(g.share).toBe(75); // recomputed, not inherited
    // Only the refused label falls through to the bucket.
    const bucket = out.groups.find((x) => x.name === REMAINDER_GROUP_NAME)!;
    expect(bucket.issueKeys).toEqual(["C-1"]);
    expect(out.groups).toHaveLength(2);
  });

  it("ignores assignments to unknown groups or already-placed labels", () => {
    const out = normalizeSynthesis(raw, signals, {
      assignments: [
        { label: "Sync", group: "A Group That Does Not Exist" },
        { label: "Ingestion", group: "Data ingestion" }, // already claimed, no-op
        { label: "Not A Real Label", group: "Data ingestion" },
      ],
    });
    expect(out.groups.find((x) => x.name === "Data ingestion")!.ticketCount).toBe(1);
    expect(out.groups.find((x) => x.name === REMAINDER_GROUP_NAME)!.ticketCount).toBe(3);
  });

  it("falls back to ONE bucket (not singletons) when the second pass produced nothing", () => {
    const out = normalizeSynthesis(raw, signals, { assignments: [] });
    expect(out.groups).toHaveLength(2);
    const bucket = out.groups[1];
    expect(bucket.name).toBe(REMAINDER_GROUP_NAME);
    expect(bucket.ticketCount).toBe(3);
    expect(bucket.issueKeys.sort()).toEqual(["A-2", "B-1", "C-1"]);
  });

  it("enforces the ceiling by folding the smallest groups into the bucket", () => {
    // 20 categories: 5 big (3 tickets each) and 15 singletons.
    const many: DefectSignal[] = [];
    for (let g = 0; g < 5; g++) {
      for (let i = 0; i < 3; i++) many.push(makeSignal(`BIG-${g}-${i}`, { category: `Big ${g}` }));
    }
    for (let i = 0; i < 15; i++) many.push(makeSignal(`SM-${i}`, { category: `Small ${i}` }));
    const modelGroups = {
      groups: [
        ...Array.from({ length: 5 }, (_, g) => ({ name: `Big ${g}`, mergesCategories: [`Big ${g}`] })),
        ...Array.from({ length: 15 }, (_, i) => ({
          name: `Small ${i}`,
          mergesCategories: [`Small ${i}`],
        })),
      ],
    };

    const out = normalizeSynthesis(modelGroups, many, { maxGroups: 6 });
    expect(out.groups).toHaveLength(6); // 5 kept + 1 bucket
    expect(out.groups.slice(0, 5).map((g) => g.name)).toEqual([
      "Big 0",
      "Big 1",
      "Big 2",
      "Big 3",
      "Big 4",
    ]);
    const bucket = out.groups[5];
    expect(bucket.name).toBe(REMAINDER_GROUP_NAME);
    expect(bucket.ticketCount).toBe(15);
    expect(bucket.description).toMatch(/folded in at the 6-group ceiling/);

    // The invariant survives the fold: every ticket in exactly one group.
    const all = out.groups.flatMap((g) => g.issueKeys);
    expect(all).toHaveLength(30);
    expect(new Set(all).size).toBe(30);
    expect(out.groups.reduce((n, g) => n + g.ticketCount, 0)).toBe(30);
    expect(out.groups.map((g) => g.share).reduce((n, s) => n + s, 0)).toBe(100);
  });

  it("defaults the ceiling to MAX_TOP_LEVEL_GROUPS", () => {
    const many: DefectSignal[] = Array.from({ length: 40 }, (_, i) =>
      makeSignal(`T-${i}`, { category: `Cat ${i}` }),
    );
    const modelGroups = {
      groups: Array.from({ length: 40 }, (_, i) => ({
        name: `Cat ${i}`,
        mergesCategories: [`Cat ${i}`],
      })),
    };
    const out = normalizeSynthesis(modelGroups, many);
    expect(MAX_TOP_LEVEL_GROUPS).toBe(14);
    expect(out.groups).toHaveLength(MAX_TOP_LEVEL_GROUPS);
    expect(out.groups[out.groups.length - 1].name).toBe(REMAINDER_GROUP_NAME);
    expect(out.groups.flatMap((g) => g.issueKeys)).toHaveLength(40);
  });

  it("does not add a bucket when the taxonomy placed everything", () => {
    const out = normalizeSynthesis(
      { groups: [{ name: "All of it", mergesCategories: ["Ingestion", "Sync", "Scale", "Weird one-off"] }] },
      signals,
    );
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0].ticketCount).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Phase 3 — deep dive
// ---------------------------------------------------------------------------

function makeGroup(over: Partial<DefectGroup> = {}): DefectGroup {
  return {
    key: "ingestion",
    name: "Ingestion",
    description: "",
    issueKeys: ["A-1", "A-2"],
    ticketCount: 2,
    share: 50,
    subGroups: [
      {
        key: "pagination",
        name: "Pagination",
        description: "",
        issueKeys: ["A-1"],
        ticketCount: 1,
        share: 50,
        topAreas: [],
        rootCauses: [],
        exampleQuotes: [],
      },
    ],
    rootCauses: [],
    analysis: "",
    escapeAnalysis: "",
    topAreas: [],
    detectionStages: [],
    triggers: [],
    severityAvg: 6,
    preventabilityAvg: 7,
    regressionCount: 0,
    exampleQuotes: [],
    ...over,
  };
}

describe("applyGroupDeepDive", () => {
  it("attaches narrative and root causes, filtering invented ticket keys", () => {
    const out = applyGroupDeepDive(makeGroup(), {
      analysis: "The cursor is persisted before the page commits.",
      escapeAnalysis: "Fixtures never cross a page boundary.",
      rootCauses: [
        {
          title: "Cursor persisted before page commit",
          explanation: "why",
          issueKeys: ["A-1", "MADE-UP-1"],
          contributingFactors: ["single-page fixtures"],
        },
        { title: "", explanation: "" }, // dropped: no content
      ],
      subGroups: [{ key: "pagination", rootCauses: [{ title: "Cursor TTL", issueKeys: ["A-1", "A-2"] }] }],
    });
    expect(out.analysis).toMatch(/cursor is persisted/);
    expect(out.escapeAnalysis).toMatch(/page boundary/);
    expect(out.rootCauses).toHaveLength(1);
    expect(out.rootCauses[0].issueKeys).toEqual(["A-1"]); // invented key removed
    // Sub-group evidence is scoped to that sub-group's own tickets.
    expect(out.subGroups[0].rootCauses[0].issueKeys).toEqual(["A-1"]);
    // Deterministic fields are untouched.
    expect(out.ticketCount).toBe(2);
    expect(out.issueKeys).toEqual(["A-1", "A-2"]);
  });

  it("is a safe no-op when the deep dive returned nothing", () => {
    const out = applyGroupDeepDive(makeGroup(), null);
    expect(out.analysis).toBe("");
    expect(out.rootCauses).toEqual([]);
    expect(out.subGroups[0].rootCauses).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Code correlation plumbing
// ---------------------------------------------------------------------------

function makeCorrelation(over: Partial<CodeCorrelation> = {}): CodeCorrelation {
  return {
    repoPath: "/repo/cookieai-core",
    repoHead: "abc123",
    totalTickets: 4,
    linkedTickets: 3,
    linkRate: 75,
    fileHotspots: [
      { path: "connectors/okta/sync.go", defectCount: 3, issueKeys: ["A-1"], teams: ["@x/int"], fileCount: 1, existsAtHead: true },
    ],
    areaHotspots: [
      // Highest defect count but deleted since — must be demoted, not recommended.
      {
        path: "controlp/internal/lifecycle_management",
        defectCount: 9,
        issueKeys: ["A-2"],
        teams: ["@x/lcm"],
        fileCount: 12,
        existsAtHead: false,
      },
      { path: "connectors/okta", defectCount: 3, issueKeys: ["A-1"], teams: ["@x/int"], fileCount: 4, existsAtHead: true },
    ],
    byTeam: [
      {
        team: "@x/integrations",
        defectCount: 2,
        issueKeys: ["A-1", "A-2"],
        fileCount: 5,
        commitCount: 4,
        testChangeRate: 25,
      },
      {
        team: "@x/graph",
        defectCount: 1,
        issueKeys: ["B-1"],
        fileCount: 2,
        commitCount: 1,
        testChangeRate: 100,
      },
    ],
    links: [],
    fixesWithTests: 2,
    fixesWithoutTests: 3,
    byGroup: [],
    ...over,
  };
}

describe("groupCodeContext", () => {
  it("prefers the group-scoped entry when the callback supplied one", () => {
    const byGroup: CodeCorrelation["byGroup"] = [
      {
        groupKey: "ingestion",
        teams: ["@x/integrations"],
        areaHotspots: [
          { path: "connectors/okta", defectCount: 2, issueKeys: [], teams: [], fileCount: 3 },
        ],
        fileHotspots: [],
        linkedTickets: 2,
      },
    ];
    const ctx = groupCodeContext("ingestion", byGroup, makeCorrelation())!;
    expect(ctx.teams).toEqual(["@x/integrations"]);
    expect(ctx.areaHotspots[0].path).toBe("connectors/okta");
    expect(ctx.linkedTickets).toBe(2);
  });

  it("falls back to repo-wide teams/hotspots, then to null", () => {
    const ctx = groupCodeContext("missing", [], makeCorrelation())!;
    expect(ctx.teams).toEqual(["@x/integrations", "@x/graph"]);
    expect(ctx.fileHotspots[0].path).toBe("connectors/okta/sync.go");
    expect(groupCodeContext("missing", null, null)).toBeNull();
  });

  it("demotes paths that no longer exist at HEAD and flags them", () => {
    const ctx = groupCodeContext("missing", null, makeCorrelation())!;
    // The stale path has the higher defect count but must not lead.
    expect(ctx.areaHotspots.map((h) => h.path)).toEqual([
      "connectors/okta",
      "controlp/internal/lifecycle_management",
    ]);
    expect(ctx.areaHotspots[1].existsAtHead).toBe(false);
    expect(ctx.hasStalePaths).toBe(true);
  });

  it("omits existsAtHead entirely when the correlation did not resolve it", () => {
    const legacy = makeCorrelation({
      areaHotspots: [
        { path: "graph/ingest", defectCount: 2, issueKeys: [], teams: [], fileCount: 3 },
      ],
      fileHotspots: [],
    });
    const ctx = groupCodeContext("missing", null, legacy)!;
    expect(ctx.areaHotspots[0]).toEqual({ path: "graph/ingest", defectCount: 2 });
    expect("existsAtHead" in ctx.areaHotspots[0]).toBe(false);
    expect(ctx.hasStalePaths).toBe(false);
  });
});

describe("teamOwnershipFromCorrelation", () => {
  it("orders teams by defect volume and de-duplicates keys", () => {
    const own = teamOwnershipFromCorrelation(makeCorrelation());
    expect(own.map((t) => t.team)).toEqual(["@x/integrations", "@x/graph"]);
    expect(own[0].issueKeys).toEqual(["A-1", "A-2"]);
  });
});

// ---------------------------------------------------------------------------
// Phase 4 — strategies
// ---------------------------------------------------------------------------

describe("normalizeStrategyPhase", () => {
  const groups = [makeGroup(), makeGroup({ key: "scale", name: "Scale", issueKeys: ["B-1"] })];
  const computed: DefectMetric[] = [
    {
      key: "customer-found-defects",
      name: "Customer-found defects",
      definition: "d",
      unit: "defects/month",
      direction: "down-good",
      source: "jira",
      automated: true,
      current: 40,
      baseline: 50,
      target: null,
      cadence: "monthly",
      series: [],
      howToMeasure: "",
      relatedGroupKeys: [],
    },
  ];

  it("keeps known group keys, drops unknown ones, and rejects wholly-unknown strategies", () => {
    const { strategies } = normalizeStrategyPhase(
      {
        strategies: [
          { title: "Multi-page connector fixtures", groupKeys: ["ingestion", "nope-1"], discipline: "integration-test" },
          { title: "Ghost work", groupKeys: ["nope-1", "nope-2"], discipline: "process" },
          { title: "Cross-cutting release checklist", discipline: "process" },
          { title: "", discipline: "process" }, // dropped: no title
        ],
      },
      groups,
      computed,
    );
    const titles = strategies.map((s) => s.title);
    expect(titles).toContain("Multi-page connector fixtures");
    expect(titles).toContain("Cross-cutting release checklist");
    expect(titles).not.toContain("Ghost work");
    expect(titles).not.toContain("");
    expect(strategies.find((s) => s.title === "Multi-page connector fixtures")!.groupKeys).toEqual([
      "ingestion",
    ]);
  });

  it("clamps enums, defaults the team, filters metric keys and de-duplicates strategy keys", () => {
    const { strategies } = normalizeStrategyPhase(
      {
        strategies: [
          {
            title: "Same title",
            discipline: "telepathy",
            effort: "gigantic",
            priority: "someday",
            metricKeys: ["customer-found-defects", "not-a-metric"],
            codeAreas: ["connectors/okta", "connectors/okta"],
          },
          { title: "Same title", discipline: "scale-test", team: "@x/graph", priority: "now" },
        ],
      },
      groups,
      computed,
    );
    expect(new Set(strategies.map((s) => s.key)).size).toBe(2);
    const fallback = strategies.find((s) => s.discipline === "process")!;
    expect(fallback.effort).toBe("medium");
    expect(fallback.priority).toBe("next");
    expect(fallback.team).toBe("Engineering");
    expect(fallback.metricKeys).toEqual(["customer-found-defects"]);
    expect(fallback.codeAreas).toEqual(["connectors/okta"]);
    // now sorts before next.
    expect(strategies[0].priority).toBe("now");
  });

  it("appends proposed metrics as non-automated, de-duped against the computed set", () => {
    const { proposedMetrics, strategies } = normalizeStrategyPhase(
      {
        strategies: [{ title: "T", metricKeys: ["page-boundary-fixture-coverage", "customer-found-defects"] }],
        proposedMetrics: [
          {
            key: "Page Boundary Fixture Coverage",
            name: "Page-boundary fixture coverage",
            definition: "Share of connectors with a multi-page fixture",
            unit: "%",
            direction: "up-good",
            source: "ci",
            cadence: "weekly",
            target: 90,
            relatedGroupKeys: ["ingestion", "bogus"],
            howToMeasure: "Count connectors whose fixture set includes >1 page.",
          },
          // Collides with a computed metric key → dropped.
          { key: "customer-found-defects", name: "Dupe", howToMeasure: "x" },
          // No instrumentation instructions → dropped.
          { key: "vibes", name: "Vibes", howToMeasure: "" },
        ],
      },
      groups,
      computed,
    );
    expect(proposedMetrics).toHaveLength(1);
    const m = proposedMetrics[0];
    expect(m.key).toBe("page-boundary-fixture-coverage");
    expect(m.automated).toBe(false);
    expect(m.series).toEqual([]);
    expect(m.current).toBeNull();
    expect(m.target).toBe(90);
    expect(m.source).toBe("ci");
    expect(m.relatedGroupKeys).toEqual(["ingestion"]); // bogus group key removed
    // A strategy may reference the newly-proposed key as well as a computed one.
    expect(strategies[0].metricKeys.sort()).toEqual([
      "customer-found-defects",
      "page-boundary-fixture-coverage",
    ]);
  });

  it("tolerates garbage input", () => {
    expect(normalizeStrategyPhase(null, groups, computed)).toEqual({
      strategies: [],
      proposedMetrics: [],
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 5 — team plans
// ---------------------------------------------------------------------------

describe("normalizeTeamPlans", () => {
  const signals = [
    makeSignal("A-1", { area: "Okta connector" }),
    makeSignal("A-2", { area: "Okta connector" }),
    makeSignal("B-1", { area: "Graph ingestion" }),
  ];
  const groups = [makeGroup(), makeGroup({ key: "scale", name: "Scale", issueKeys: ["B-1"] })];
  const strategies = normalizeStrategyPhase(
    { strategies: [{ key: "fixtures", title: "Fixtures", groupKeys: ["ingestion"] }] },
    groups,
    [],
  ).strategies;
  const metrics: DefectMetric[] = [
    {
      key: "escape-rate",
      name: "Escape rate",
      definition: "",
      unit: "%",
      direction: "down-good",
      source: "jira",
      automated: true,
      current: null,
      baseline: null,
      target: null,
      cadence: "monthly",
      series: [],
      howToMeasure: "",
      relatedGroupKeys: [],
    },
  ];

  it("derives counts, keys, groups and areas from the correlation, not the model", () => {
    const ownership = teamOwnershipFromCorrelation(makeCorrelation());
    const raw = [
      {
        team: "@x/integrations",
        label: "Integrations",
        summary: "Your fixtures never cross a page boundary.",
        defectCount: 4242, // ignored
        issueKeys: ["MADE-UP-1"], // ignored — correlation is authoritative
        strategyKeys: ["fixtures", "not-a-strategy"],
        metricKeys: ["escape-rate", "not-a-metric"],
      },
    ];
    const correlation = makeCorrelation();
    const plans = normalizeTeamPlans(
      raw,
      ownership,
      groups,
      signals,
      strategies,
      metrics,
      correlation,
    );
    expect(plans.map((p) => p.team)).toEqual(["@x/integrations", "@x/graph"]);
    const int = plans[0];
    expect(int.defectCount).toBe(2);
    expect(int.issueKeys).toEqual(["A-1", "A-2"]);
    expect(int.label).toBe("Integrations");
    expect(int.summary).toMatch(/page boundary/);
    expect(int.topGroups).toEqual([{ groupKey: "ingestion", name: "Ingestion", ticketCount: 2 }]);
    expect(int.topAreas).toEqual(["Okta connector"]);
    expect(int.strategyKeys).toEqual(["fixtures"]);
    expect(int.metricKeys).toEqual(["escape-rate"]);
    // Denormalized from correlation.byTeam so the card reads standalone.
    expect(int.testChangeRate).toBe(25);
    expect(int.commitCount).toBe(4);
    // The team the model said nothing about still gets a plan with real counts.
    const graph = plans[1];
    expect(graph.defectCount).toBe(1);
    expect(graph.label).toBe("Graph"); // derived from the slug
    expect(graph.summary).toBe("");
  });

  it("falls back to the model's attribution when there is no correlation", () => {
    const raw = [
      { team: "Integrations", summary: "s", issueKeys: ["A-1", "A-2", "GHOST-1"] },
      { team: "Graph", summary: "g", issueKeys: ["B-1"] },
      { team: "Phantom", summary: "p", issueKeys: ["NOPE-1"] }, // no real tickets → dropped
    ];
    const plans = normalizeTeamPlans(raw, [], groups, signals, strategies, metrics);
    expect(plans.map((p) => p.team)).toEqual(["Integrations", "Graph"]);
    expect(plans[0].defectCount).toBe(2); // GHOST-1 filtered out
    expect(plans[0].issueKeys).toEqual(["A-1", "A-2"]);
    // No git data → left undefined rather than faked as 0.
    expect(plans[0].testChangeRate).toBeUndefined();
    expect(plans[0].commitCount).toBeUndefined();
  });

  it("returns no plans when there is neither correlation nor model attribution", () => {
    expect(normalizeTeamPlans(null, [], groups, signals, strategies, metrics)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phase 6 — per-component narrative
// ---------------------------------------------------------------------------

function makeComponentSlice(over: Partial<ComponentAnalysis> = {}): ComponentAnalysis {
  return {
    component: "Lifecycle Management",
    slug: "lifecycle-management",
    defectCount: 3,
    share: 60,
    issueKeys: ["A-1", "A-2", "B-1"],
    severityAvg: 6.5,
    preventabilityAvg: 7.5,
    regressionCount: 1,
    detectionStages: [{ stage: "integration-test", count: 3 }],
    triggers: [{ trigger: "data-scale", count: 3 }],
    topAreas: ["Okta connector"],
    topFailureModes: ["Pagination cursor expiry"],
    groups: [
      {
        groupKey: "ingestion",
        name: "Ingestion",
        ticketCount: 2,
        share: 67,
        issueKeys: ["A-1", "A-2"],
        detectionStages: [{ stage: "integration-test", count: 2 }],
        triggers: [{ trigger: "data-scale", count: 2 }],
      },
    ],
    summary: "",
    escapeAnalysis: "",
    strategies: [],
    metrics: [],
    codeCorrelation: makeCorrelation(),
    teams: makeCorrelation().byTeam,
    ...over,
  };
}

describe("componentStrategyKey", () => {
  it("namespaces by component slug so a component key cannot shadow a global one", () => {
    expect(componentStrategyKey("lifecycle-management", "multi-page-fixtures")).toBe(
      "comp-lifecycle-management-multi-page-fixtures",
    );
    // Both halves are slugified, so a model-written key with spaces or capitals
    // still lands in the same namespace.
    expect(componentStrategyKey("Access Review", "Fix The Thing")).toBe(
      "comp-access-review-fix-the-thing",
    );
  });
});

describe("componentCodeContext", () => {
  it("demotes and flags paths that no longer exist at HEAD, exactly like the deep dive", () => {
    const ctx = componentCodeContext(makeComponentSlice())!;
    expect(ctx.teams).toEqual(["@x/integrations", "@x/graph"]);
    expect(ctx.areaHotspots.map((h) => h.path)).toEqual([
      "connectors/okta",
      "controlp/internal/lifecycle_management",
    ]);
    expect(ctx.areaHotspots[1].existsAtHead).toBe(false);
    expect(ctx.hasStalePaths).toBe(true);
  });

  it("is null when the component has neither teams nor hotspots", () => {
    expect(componentCodeContext(makeComponentSlice({ codeCorrelation: null, teams: [] }))).toBeNull();
  });
});

describe("componentPromptPayload", () => {
  it("carries the component's own stats, group slices, metric keys and a bounded sample", () => {
    const signals = new Map(
      [
        makeSignal("A-1", { severityScore: 3 }),
        makeSignal("A-2", { severityScore: 9 }),
      ].map((s) => [s.issueKey, s]),
    );
    const payload = componentPromptPayload(makeComponentSlice(), signals, {
      metricKeys: ["escape-rate"],
      reportSummary: "R".repeat(2000),
    });
    expect(payload.component.name).toBe("Lifecycle Management");
    expect(payload.component.defectCount).toBe(3);
    expect(payload.groups.map((g) => g.groupKey)).toEqual(["ingestion"]);
    expect(payload.metricKeys).toEqual(["escape-rate"]);
    // The report-wide summary is supplied (so the model can say something else)
    // but clamped — it is context, not the payload.
    expect(payload.reportWideSummary).toHaveLength(600);
    // Samples: only signals we actually have, most severe first, B-1 absent.
    expect(payload.samples.map((s) => s.key)).toEqual(["A-2", "A-1"]);
    expect(payload.codeContext?.teams).toContain("@x/integrations");
  });

  it("caps the sample at 20 signals", () => {
    const many = Array.from({ length: 40 }, (_, i) => makeSignal(`M-${i}`));
    const payload = componentPromptPayload(
      makeComponentSlice({ issueKeys: many.map((s) => s.issueKey), defectCount: 40 }),
      new Map(many.map((s) => [s.issueKey, s])),
    );
    expect(payload.samples).toHaveLength(20);
  });
});

describe("applyComponentNarrative", () => {
  it("attaches narrative and namespaced strategies, filtering group and metric keys", () => {
    const out = applyComponentNarrative(
      makeComponentSlice(),
      {
        summary: "Provisioning retries re-send the whole batch after a partial 207.",
        escapeAnalysis: "No fixture returns a partial-success 207 from the SCIM endpoint.",
        strategies: [
          {
            key: "partial-207-fixture",
            title: "Add a partial-success SCIM fixture",
            detail: "d",
            discipline: "integration-test",
            team: "@x/integrations",
            groupKeys: ["ingestion", "not-in-this-component"],
            effort: "low",
            priority: "now",
            expectedImpact: "i",
            metricKeys: ["escape-rate", "not-a-metric"],
            codeAreas: ["connectors/okta", "controlp/internal/lifecycle_management"],
          },
          // Cites only a group this component does not have → ungrounded, dropped.
          { title: "Ghost work", groupKeys: ["nope-1", "nope-2"] },
          { title: "" }, // no title → dropped
        ],
      },
      { metricKeys: ["escape-rate"] },
    );

    expect(out.summary).toMatch(/partial 207/);
    expect(out.escapeAnalysis).toMatch(/SCIM endpoint/);
    expect(out.strategies).toHaveLength(1);
    const s = out.strategies[0];
    expect(s.key).toBe("comp-lifecycle-management-partial-207-fixture");
    expect(s.groupKeys).toEqual(["ingestion"]); // foreign group key stripped
    expect(s.metricKeys).toEqual(["escape-rate"]); // unknown metric stripped
    expect(s.discipline).toBe("integration-test");
    expect(s.priority).toBe("now");
    // The stale hotspot is removed from codeAreas — no action item aimed at a
    // directory that no longer exists.
    expect(s.codeAreas).toEqual(["connectors/okta"]);
  });

  it("defaults the team to the component's largest owning team", () => {
    const out = applyComponentNarrative(makeComponentSlice(), {
      strategies: [{ title: "Something", team: "" }],
    });
    expect(out.strategies[0].team).toBe("@x/integrations");
    // With no correlation at all it falls back to the generic owner.
    const orphan = applyComponentNarrative(
      makeComponentSlice({ teams: [], codeCorrelation: null }),
      { strategies: [{ title: "Something" }] },
    );
    expect(orphan.strategies[0].team).toBe("Engineering");
  });

  it("cannot collide with a global strategy key, or with a sibling in the same component", () => {
    const out = applyComponentNarrative(
      makeComponentSlice(),
      {
        strategies: [
          { key: "fixtures", title: "First" },
          { key: "fixtures", title: "Second" },
        ],
      },
      {
        // A global strategy already occupies the namespaced key — vanishingly
        // unlikely, but the report links strategies by key, so "unlikely" is
        // not good enough.
        reservedStrategyKeys: ["comp-lifecycle-management-fixtures"],
      },
    );
    expect(out.strategies.map((s) => s.key)).toEqual([
      "comp-lifecycle-management-fixtures-2",
      "comp-lifecycle-management-fixtures-3",
    ]);
  });

  it("ignores a hostile response that tries to rewrite the deterministic fields", () => {
    const slice = makeComponentSlice();
    const out = applyComponentNarrative(slice, {
      summary: "s",
      defectCount: 9999,
      share: 100,
      issueKeys: ["MADE-UP-1"],
      severityAvg: 10,
      regressionCount: 42,
      detectionStages: [{ stage: "not-preventable", count: 999 }],
      groups: [{ groupKey: "invented", name: "Invented", ticketCount: 500 }],
      metrics: [{ key: "made-up" }],
      teams: [{ team: "@x/nobody" }],
      codeCorrelation: null,
    });
    expect(out.defectCount).toBe(3);
    expect(out.share).toBe(60);
    expect(out.issueKeys).toEqual(slice.issueKeys);
    expect(out.severityAvg).toBe(6.5);
    expect(out.regressionCount).toBe(1);
    expect(out.detectionStages).toEqual(slice.detectionStages);
    expect(out.groups).toEqual(slice.groups);
    expect(out.metrics).toEqual([]);
    expect(out.teams).toEqual(slice.teams);
    expect(out.codeCorrelation).toEqual(slice.codeCorrelation);
    expect(out.component).toBe("Lifecycle Management");
  });

  it("clamps the word budgets in the same proportion as the global fields", () => {
    const out = applyComponentNarrative(makeComponentSlice(), {
      summary: "w ".repeat(2000),
      escapeAnalysis: "w ".repeat(2000),
      strategies: [{ title: "T".repeat(400), detail: "d".repeat(2000), expectedImpact: "e".repeat(900) }],
    });
    expect(out.summary).toHaveLength(840); // 90 words
    expect(out.escapeAnalysis).toHaveLength(560); // 60 words
    expect(out.strategies[0].detail).toHaveLength(600); // same as a global strategy
    expect(out.strategies[0].title).toHaveLength(200);
    expect(out.strategies[0].expectedImpact).toHaveLength(400);
  });

  it("keeps at most 4 strategies, highest priority first", () => {
    const out = applyComponentNarrative(makeComponentSlice(), {
      strategies: [
        { title: "Later A", priority: "later" },
        { title: "Next A", priority: "next" },
        { title: "Now A", priority: "now" },
        { title: "Now B", priority: "now" },
        { title: "Later B", priority: "later" },
        { title: "Next B", priority: "next" },
      ],
    });
    expect(out.strategies.map((s) => s.title)).toEqual(["Now A", "Now B", "Next A", "Next B"]);
  });

  it("degrades to empty narrative fields on a null/garbage response", () => {
    const out = applyComponentNarrative(makeComponentSlice(), null);
    expect(out.summary).toBe("");
    expect(out.escapeAnalysis).toBe("");
    expect(out.strategies).toEqual([]);
    expect(out.defectCount).toBe(3);
    expect(out.groups).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// emptyProductDefectAnalysis
// ---------------------------------------------------------------------------

describe("emptyProductDefectAnalysis", () => {
  it("distinguishes a zero-ticket population from a zero-signal one", () => {
    const zero = emptyProductDefectAnalysis(0, "project = EAC");
    expect(zero.executiveSummary).toMatch(/No tickets matched/);
    expect(zero.jql).toBe("project = EAC");
    expect(zero.totalTickets).toBe(0);
    expect(zero.analyzedTickets).toBe(0);
    expect(zero.groups).toEqual([]);
    expect(zero.strategies).toEqual([]);
    expect(zero.metrics).toEqual([]);
    expect(zero.teamPlans).toEqual([]);
    expect(zero.signals).toEqual([]);
    expect(zero.components).toEqual([]);
    expect(zero.codeCorrelation).toBeNull();
    expect(emptyProductDefectAnalysis(5).executiveSummary).toMatch(/No analyzable signal/);
    expect(emptyProductDefectAnalysis().jql).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Route a stubbed completion by the phase-unique marker in its system prompt. */
function phaseOf(system: string): string {
  if (system.includes("DEFECT ESCAPE ANALYSIS")) return "extract";
  if (system.includes("canonical TAXONOMY")) return "synthesize";
  if (system.includes("finishing a defect taxonomy")) return "placement";
  if (system.includes("deep-dive section")) return "deep-dive";
  if (system.includes("PREVENTION PROGRAMME")) return "strategies";
  if (system.includes("per-team section")) return "teams";
  if (system.includes("drilldown page for ONE JIRA COMPONENT")) return "components";
  return "unknown";
}

function keysIn(user: string): string[] {
  return [...user.matchAll(/"key":"([^"]+)"/g)].map((m) => m[1]);
}

type CompleteOpts = {
  model: string;
  system: string;
  user: string;
  systemCacheable?: boolean;
  maxTokens?: number;
};

function stubComplete(log?: string[], users?: Record<string, string>): CompletionFn {
  return (async (opts: CompleteOpts) => {
    const phase = phaseOf(opts.system);
    log?.push(phase);
    if (users && !(phase in users)) users[phase] = opts.user;
    switch (phase) {
      case "extract":
        return keysIn(opts.user).map((k) => ({
          issueKey: k,
          area: "Okta connector",
          failureMode: "Pagination cursor expiry",
          symptom: "Missing groups",
          suspectedRootCause: "cursor persisted early",
          triggerCondition: "large tenant",
          trigger: "data-scale",
          escapeReason: "single-page fixtures",
          detectionStage: "integration-test",
          errorSignatures: ["429"],
          category: "Data ingestion correctness",
          subCategory: "Pagination & cursors",
          isRegression: false,
          customerImpact: "stale access review",
          severityScore: 7,
          preventability: 8,
        })) as Any_;
      case "synthesize":
        return {
          executiveSummary: "Integration-test coverage is the dominant gap.",
          groups: [
            {
              name: "Data ingestion correctness",
              description: "Extraction pipeline defects.",
              mergesCategories: ["Data ingestion correctness"],
              subGroups: [
                { name: "Pagination & cursors", mergesSubCategories: ["Pagination & cursors"] },
              ],
            },
          ],
        } as Any_;
      case "deep-dive":
        return {
          analysis: "The cursor is committed before the page is persisted.",
          escapeAnalysis: "Fixtures are recorded from a single-page sandbox tenant.",
          rootCauses: [{ title: "Cursor ordering", explanation: "e", issueKeys: keysIn(opts.user).slice(0, 2) }],
        } as Any_;
      case "strategies":
        return {
          strategies: [
            {
              key: "multi-page-fixtures",
              title: "Record multi-page connector fixtures",
              detail: "d",
              discipline: "integration-test",
              team: "@x/integrations",
              groupKeys: ["data-ingestion-correctness", "not-real"],
              effort: "medium",
              priority: "now",
              expectedImpact: "i",
              metricKeys: ["escape-rate", "fixture-coverage"],
              codeAreas: ["connectors/okta"],
            },
            { title: "Ungrounded", groupKeys: ["not-real"] },
          ],
          proposedMetrics: [
            {
              key: "fixture-coverage",
              name: "Fixture coverage",
              definition: "d",
              unit: "%",
              direction: "up-good",
              source: "ci",
              cadence: "monthly",
              howToMeasure: "Count connectors with a multi-page fixture in CI.",
              relatedGroupKeys: ["data-ingestion-correctness"],
            },
          ],
        } as Any_;
      case "teams":
        return [
          {
            team: "@x/integrations",
            label: "Integrations",
            summary: "Your fixtures never cross a page boundary.",
            strategyKeys: ["multi-page-fixtures"],
            metricKeys: ["escape-rate"],
          },
        ] as Any_;
      case "components":
        return {
          summary: "Provisioning retries re-send the whole batch after a partial 207.",
          escapeAnalysis: "No fixture returns a partial-success 207 from the SCIM endpoint.",
          strategies: [
            {
              // Deliberately the same bare key the global phase used — it must
              // end up namespaced, not shadowing the global strategy.
              key: "multi-page-fixtures",
              title: "Add a partial-success SCIM fixture",
              discipline: "integration-test",
              team: "@x/integrations",
              groupKeys: ["data-ingestion-correctness"],
              priority: "now",
              metricKeys: ["escape-rate", "not-a-metric"],
              codeAreas: ["connectors/okta", "controlp/internal/lifecycle_management"],
            },
            { title: "Ungrounded", groupKeys: ["a-group-this-component-lacks"] },
          ],
          // Hostile extras the normalizer must ignore.
          defectCount: 9999,
        } as Any_;
      default:
        return {} as Any_;
    }
  }) as CompletionFn;
}

const ESCAPE_RATE: DefectMetric = {
  key: "escape-rate",
  name: "Escape rate",
  definition: "Customer-found share of all defects",
  unit: "%",
  direction: "down-good",
  source: "jira",
  automated: true,
  current: 31,
  baseline: 28,
  target: null,
  cadence: "monthly",
  series: [{ period: "2026-07", value: 31 }],
  howToMeasure: "",
  relatedGroupKeys: [],
};

describe("analyzeProductDefects (orchestration with an injected LLM)", () => {
  it("returns the empty report for zero issues without calling the model", async () => {
    let calls = 0;
    const complete: CompletionFn = (async () => {
      calls++;
      return {} as Any_;
    }) as CompletionFn;
    const out = await analyzeProductDefects([], { complete, jql: "project = EAC" });
    expect(calls).toBe(0);
    expect(out.analyzedTickets).toBe(0);
    expect(out.jql).toBe("project = EAC");
  });

  it("runs all five phases, batches extraction, and assembles a deterministic report", async () => {
    const issues = Array.from({ length: 5 }, (_, i) => makeIssue(`EAC-${i}`));
    const phases: string[] = [];
    const users: Record<string, string> = {};
    const progress: string[] = [];
    const correlation = makeCorrelation({
      byTeam: [
        {
          team: "@x/integrations",
          defectCount: 3,
          issueKeys: ["EAC-0", "EAC-1", "EAC-2"],
          fileCount: 5,
          commitCount: 4,
          testChangeRate: 20,
        },
      ],
    });
    let groupsSeenByCallback: string[] = [];

    const out = await analyzeProductDefects(issues, {
      complete: stubComplete(phases, users),
      batchSize: 2,
      parallel: 2,
      jql: "project = EAC AND Customer is not EMPTY",
      correlation,
      metrics: [ESCAPE_RATE],
      correlationForGroups: (gs) => {
        groupsSeenByCallback = gs.map((g) => g.key);
        return [
          {
            groupKey: gs[0].key,
            teams: ["@x/integrations"],
            areaHotspots: [],
            fileHotspots: [],
            linkedTickets: 3,
          },
        ];
      },
      onProgress: (e) => progress.push(e.phase),
    });

    // 3 extraction batches (5 issues / 2) + synthesize + 1 deep dive + strategies + teams.
    expect(phases.filter((p) => p === "extract")).toHaveLength(3);
    expect(phases.filter((p) => p === "deep-dive")).toHaveLength(1);
    expect(phases).toHaveLength(7);
    for (const p of ["extract", "synthesize", "deep-dive", "strategies", "teams"]) {
      expect(progress).toContain(p);
    }

    expect(out.totalTickets).toBe(5);
    expect(out.analyzedTickets).toBe(5);
    expect(out.signals).toHaveLength(5);
    expect(out.jql).toBe("project = EAC AND Customer is not EMPTY");
    expect(out.codeCorrelation).toBe(correlation);

    // Taxonomy: one group holding every ticket, with a sub-group.
    expect(out.groups).toHaveLength(1);
    const g = out.groups[0];
    expect(g.key).toBe("data-ingestion-correctness");
    expect(g.ticketCount).toBe(5);
    expect(g.share).toBe(100);
    expect(g.subGroups[0].ticketCount).toBe(5);
    expect(g.subGroups[0].share).toBe(100);
    expect(g.severityAvg).toBe(7);
    expect(g.preventabilityAvg).toBe(8);
    expect(g.detectionStages).toEqual([{ stage: "integration-test", count: 5 }]);

    // Deep dive ran with the group-scoped correlation resolved after synthesis.
    expect(groupsSeenByCallback).toEqual(["data-ingestion-correctness"]);
    expect(g.analysis).toMatch(/cursor is committed/);
    expect(g.escapeAnalysis).toMatch(/single-page sandbox/);
    expect(g.rootCauses[0].issueKeys.every((k) => g.issueKeys.includes(k))).toBe(true);

    // Strategies: the ungrounded one is dropped, the unknown group key stripped.
    expect(out.strategies).toHaveLength(1);
    expect(out.strategies[0].groupKeys).toEqual(["data-ingestion-correctness"]);
    expect(out.strategies[0].metricKeys.sort()).toEqual(["escape-rate", "fixture-coverage"]);

    // Metrics: the computed one is passed through untouched, the proposal appended.
    expect(out.metrics.map((m) => m.key)).toEqual(["escape-rate", "fixture-coverage"]);
    expect(out.metrics[0]).toBe(ESCAPE_RATE);
    expect(out.metrics[1].automated).toBe(false);

    // Team plans: counts come from the correlation, prose from the model.
    expect(out.teamPlans).toHaveLength(1);
    expect(out.teamPlans[0].defectCount).toBe(3);
    expect(out.teamPlans[0].issueKeys).toEqual(["EAC-0", "EAC-1", "EAC-2"]);
    expect(out.teamPlans[0].strategyKeys).toEqual(["multi-page-fixtures"]);
    expect(out.teamPlans[0].summary).toMatch(/page boundary/);
    expect(out.teamPlans[0].testChangeRate).toBe(20);
    expect(out.teamPlans[0].commitCount).toBe(4);

    // The strategy prompt lists live hot paths before stale ones and marks the
    // stale one, so the model won't aim an action item at a deleted directory.
    const areas: Array<{ path: string; existsAtHead?: boolean }> = JSON.parse(
      users.strategies.slice(users.strategies.indexOf("{")),
    ).hotCodeAreas;
    expect(areas.map((a) => a.path)).toEqual([
      "connectors/okta",
      "controlp/internal/lifecycle_management",
    ]);
    expect(areas[1].existsAtHead).toBe(false);
  });

  it("keeps every ticket when an extraction batch throws", async () => {
    const issues = Array.from({ length: 6 }, (_, i) => makeIssue(`EAC-${i}`));
    const inner = stubComplete();
    let extractCalls = 0;
    const flaky: CompletionFn = (async (opts: CompleteOpts) => {
      if (phaseOf(opts.system) === "extract") {
        extractCalls++;
        if (extractCalls === 1) throw new Error("overloaded");
      }
      return inner(opts);
    }) as CompletionFn;

    const out = await analyzeProductDefects(issues, { complete: flaky, batchSize: 2, parallel: 1 });
    expect(out.signals).toHaveLength(6);
    expect(out.analyzedTickets).toBe(6);
    // The failed batch's tickets fell back to safe defaults but were not lost.
    const defaults = out.signals.filter((s) => s.failureMode === "Unclassified");
    expect(defaults).toHaveLength(2);
    // Crucially NOT "not-preventable": a failed batch must not inflate the
    // "nothing could have caught it" bucket.
    expect(defaults.every((s) => s.detectionStage === "unclassified")).toBe(true);
    // Every ticket is still in exactly one group.
    const all = out.groups.flatMap((g) => g.issueKeys);
    expect(all).toHaveLength(6);
    expect(new Set(all).size).toBe(6);
  });

  it("degrades to a flat taxonomy and empty later phases when every call fails", async () => {
    const issues = Array.from({ length: 3 }, (_, i) => makeIssue(`EAC-${i}`));
    const broken: CompletionFn = (async () => {
      throw new Error("nope");
    }) as CompletionFn;
    const out = await analyzeProductDefects(issues, { complete: broken, batchSize: 3 });
    expect(out.analyzedTickets).toBe(3);
    expect(out.groups).toHaveLength(1); // all "Uncategorized"
    expect(out.groups[0].ticketCount).toBe(3);
    expect(out.strategies).toEqual([]);
    expect(out.teamPlans).toEqual([]);
    expect(out.executiveSummary).toMatch(/no executive summary/i);
  });

  it("resumes from cached signals, re-sending only the remainder", async () => {
    const issues = Array.from({ length: 6 }, (_, i) => makeIssue(`EAC-${i}`));
    const cachedSignals = [
      makeSignal("EAC-0", { failureMode: "FROM CACHE", category: "Data ingestion correctness" }),
      makeSignal("EAC-1", { failureMode: "FROM CACHE", category: "Data ingestion correctness" }),
      // A ticket that has since dropped out of the population — must be ignored.
      makeSignal("GONE-9", { failureMode: "FROM CACHE" }),
    ];
    const phases: string[] = [];
    const sentKeys: string[] = [];
    const checkpoints: string[][] = [];
    const progress: Array<{ done: number; total: number }> = [];
    const inner = stubComplete(phases);
    const complete: CompletionFn = (async (opts: CompleteOpts) => {
      if (phaseOf(opts.system) === "extract") sentKeys.push(...keysIn(opts.user));
      return inner(opts);
    }) as CompletionFn;

    const out = await analyzeProductDefects(issues, {
      complete,
      batchSize: 2,
      parallel: 1,
      cachedSignals,
      onSignalsBatch: (batch) => checkpoints.push(batch.map((s) => s.issueKey)),
      onProgress: (e) => {
        if (e.phase === "extract") progress.push({ done: e.done, total: e.total });
      },
    });

    // Only the 4 uncached tickets were re-sent: 2 batches, not 3.
    expect(phases.filter((p) => p === "extract")).toHaveLength(2);
    expect(sentKeys.sort()).toEqual(["EAC-2", "EAC-3", "EAC-4", "EAC-5"]);
    // Cached signals are reused verbatim and the stale one is dropped.
    expect(out.signals).toHaveLength(6);
    expect(out.signals.map((s) => s.issueKey)).toEqual([
      "EAC-0",
      "EAC-1",
      "EAC-2",
      "EAC-3",
      "EAC-4",
      "EAC-5",
    ]); // merged back into issue order
    expect(out.signals.filter((s) => s.failureMode === "FROM CACHE")).toHaveLength(2);
    expect(out.signals.some((s) => s.issueKey === "GONE-9")).toBe(false);
    expect(out.analyzedTickets).toBe(6);

    // Checkpoints fire per batch, with that batch's signals only.
    expect(checkpoints).toEqual([
      ["EAC-2", "EAC-3"],
      ["EAC-4", "EAC-5"],
    ]);

    // Progress spans the whole population and starts at the cached count, so a
    // resumed run does not look like it restarted from zero.
    expect(progress.every((p) => p.total === 6)).toBe(true);
    expect(progress[0].done).toBe(2);
    expect(progress[progress.length - 1].done).toBe(6);
  });

  it("skips the extract phase entirely when every ticket is cached", async () => {
    const issues = Array.from({ length: 3 }, (_, i) => makeIssue(`EAC-${i}`));
    const cachedSignals = issues.map((i) =>
      makeSignal(i.key, { category: "Data ingestion correctness" }),
    );
    const phases: string[] = [];
    const progress: string[] = [];
    let checkpointed = false;

    const out = await analyzeProductDefects(issues, {
      complete: stubComplete(phases),
      cachedSignals,
      onSignalsBatch: () => {
        checkpointed = true;
      },
      onProgress: (e) => progress.push(e.phase),
    });

    expect(phases).not.toContain("extract");
    expect(progress).not.toContain("extract");
    expect(checkpointed).toBe(false);
    expect(out.signals).toHaveLength(3);
    expect(out.groups[0].ticketCount).toBe(3);
    // Synthesis onward still ran.
    expect(phases).toContain("synthesize");
    expect(phases).toContain("deep-dive");
  });

  it("keeps extracting when the signal checkpoint throws", async () => {
    const issues = Array.from({ length: 4 }, (_, i) => makeIssue(`EAC-${i}`));
    let calls = 0;
    const out = await analyzeProductDefects(issues, {
      complete: stubComplete(),
      batchSize: 2,
      parallel: 1,
      onSignalsBatch: () => {
        calls++;
        throw new Error("sqlite is busy");
      },
    });
    expect(calls).toBe(2); // both batches still attempted a checkpoint
    expect(out.signals).toHaveLength(4);
    expect(out.groups[0].ticketCount).toBe(4);
  });

  it("makes one second-pass placement call for labels synthesis left unplaced", async () => {
    // Two extraction categories; synthesis names a group for only one of them.
    const issues = [makeIssue("EAC-0"), makeIssue("EAC-1")];
    const phases: string[] = [];
    const placementUsers: string[] = [];
    const complete: CompletionFn = (async (opts: CompleteOpts) => {
      const phase = phaseOf(opts.system);
      phases.push(phase);
      switch (phase) {
        case "extract":
          return keysIn(opts.user).map((k, i) => ({
            issueKey: k,
            category: i === 0 ? "Ingestion" : "Odd corner",
            detectionStage: "integration-test",
            trigger: "data-scale",
            severityScore: 5,
            preventability: 5,
          })) as Any_;
        case "synthesize":
          return {
            executiveSummary: "s",
            groups: [{ name: "Data ingestion", mergesCategories: ["Ingestion"] }],
          } as Any_;
        case "placement":
          placementUsers.push(opts.user);
          return { assignments: [{ label: "Odd corner", group: "Data ingestion" }] } as Any_;
        default:
          return {} as Any_;
      }
    }) as CompletionFn;

    const out = await analyzeProductDefects(issues, { complete, batchSize: 2 });
    expect(phases.filter((p) => p === "placement")).toHaveLength(1);
    // The placement call sees only the leftover label, not the whole taxonomy.
    expect(placementUsers[0]).toContain("Odd corner");
    expect(placementUsers[0]).not.toContain('"Ingestion"');
    // Both tickets land in the single named group; no remainder bucket at all.
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0].name).toBe("Data ingestion");
    expect(out.groups[0].ticketCount).toBe(2);
    expect(out.groups[0].share).toBe(100);
  });

  it("falls back to one remainder bucket when the placement call fails", async () => {
    const issues = [makeIssue("EAC-0"), makeIssue("EAC-1"), makeIssue("EAC-2")];
    const complete: CompletionFn = (async (opts: CompleteOpts) => {
      const phase = phaseOf(opts.system);
      if (phase === "placement") throw new Error("overloaded");
      if (phase === "extract") {
        return keysIn(opts.user).map((k, i) => ({
          issueKey: k,
          category: i === 0 ? "Ingestion" : `Straggler ${i}`,
        })) as Any_;
      }
      if (phase === "synthesize") {
        return { groups: [{ name: "Data ingestion", mergesCategories: ["Ingestion"] }] } as Any_;
      }
      return {} as Any_;
    }) as CompletionFn;

    const out = await analyzeProductDefects(issues, { complete, batchSize: 3 });
    // Two stragglers → ONE bucket, not two singleton groups.
    expect(out.groups).toHaveLength(2);
    expect(out.groups[1].name).toBe(REMAINDER_GROUP_NAME);
    expect(out.groups[1].ticketCount).toBe(2);
    const all = out.groups.flatMap((g) => g.issueKeys);
    expect(new Set(all).size).toBe(3);
  });

  it("survives a throwing correlationForGroups callback", async () => {
    const issues = [makeIssue("EAC-0")];
    const out = await analyzeProductDefects(issues, {
      complete: stubComplete(),
      correlationForGroups: () => {
        throw new Error("git exploded");
      },
    });
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0].analysis).toMatch(/cursor is committed/);
  });

  // -------------------------------------------------------------------------
  // Phase 6 — components
  // -------------------------------------------------------------------------

  /** Two component slices whose group keys match the stub taxonomy. */
  function stubSlices(): ComponentAnalysis[] {
    return ["Integrations", "Lifecycle Management"].map((name, i) =>
      makeComponentSlice({
        component: name,
        slug: name.toLowerCase().replace(/\s+/g, "-"),
        defectCount: 2 - i,
        issueKeys: ["EAC-0", "EAC-1"].slice(0, 2 - i),
        groups: [
          {
            groupKey: "data-ingestion-correctness",
            name: "Data ingestion correctness",
            ticketCount: 2 - i,
            share: 100,
            issueKeys: ["EAC-0", "EAC-1"].slice(0, 2 - i),
            detectionStages: [{ stage: "integration-test", count: 2 - i }],
            triggers: [{ trigger: "data-scale", count: 2 - i }],
          },
        ],
      }),
    );
  }

  it("makes one model call per component and narrates each deterministic slice", async () => {
    const issues = [makeIssue("EAC-0"), makeIssue("EAC-1")];
    const phases: string[] = [];
    const componentProgress: Array<{ done: number; total: number }> = [];
    let sawSignals: string[] = [];
    let sawGroups: string[] = [];

    const out = await analyzeProductDefects(issues, {
      complete: stubComplete(phases),
      batchSize: 2,
      metrics: [ESCAPE_RATE],
      componentSlices: (signals, groups) => {
        sawSignals = signals.map((s) => s.issueKey);
        sawGroups = groups.map((g) => g.key);
        return stubSlices();
      },
      onProgress: (e) => {
        if (e.phase === "components") componentProgress.push({ done: e.done, total: e.total });
      },
    });

    // One call per component — nine components would add nine calls.
    expect(phases.filter((p) => p === "components")).toHaveLength(2);
    // Resolved AFTER the taxonomy exists, with the merged signals and the
    // normalized groups (not the model's raw synthesis).
    expect(sawSignals).toEqual(["EAC-0", "EAC-1"]);
    expect(sawGroups).toEqual(["data-ingestion-correctness"]);
    // Progress counts components, not batches.
    expect(componentProgress).toEqual([
      { done: 0, total: 2 },
      { done: 1, total: 2 },
      { done: 2, total: 2 },
    ]);

    expect(out.components).toHaveLength(2);
    // Order is the deterministic module's, preserved through the pool.
    expect(out.components.map((c) => c.component)).toEqual(["Integrations", "Lifecycle Management"]);
    const c = out.components[0];
    expect(c.summary).toMatch(/partial 207/);
    expect(c.escapeAnalysis).toMatch(/SCIM endpoint/);
    // The ungrounded strategy is dropped; the survivor is namespaced by slug so
    // it cannot be mistaken for — or collide with — the global one of the same
    // bare key.
    expect(c.strategies).toHaveLength(1);
    expect(c.strategies[0].key).toBe("comp-integrations-multi-page-fixtures");
    expect(out.strategies[0].key).toBe("multi-page-fixtures");
    expect(c.strategies[0].groupKeys).toEqual(["data-ingestion-correctness"]);
    // Metric keys are filtered against the report's real metric set.
    expect(c.strategies[0].metricKeys).toEqual(["escape-rate"]);
    // The stale hotspot never reaches an action item.
    expect(c.strategies[0].codeAreas).toEqual(["connectors/okta"]);
    // Deterministic fields survive the model's attempt to rewrite them.
    expect(c.defectCount).toBe(2);
    expect(c.issueKeys).toEqual(["EAC-0", "EAC-1"]);
    expect(c.groups[0].ticketCount).toBe(2);
  });

  it("keeps a failed component's deterministic fields with an empty narrative", async () => {
    const issues = [makeIssue("EAC-0"), makeIssue("EAC-1")];
    const inner = stubComplete();
    const complete: CompletionFn = (async (opts: CompleteOpts) => {
      if (phaseOf(opts.system) === "components" && opts.user.includes("Integrations")) {
        throw new Error("overloaded");
      }
      return inner(opts);
    }) as CompletionFn;

    const out = await analyzeProductDefects(issues, {
      complete,
      batchSize: 2,
      componentSlices: () => stubSlices(),
    });

    // The slice is kept, not dropped — the page still renders every
    // deterministic section, which is most of it.
    expect(out.components).toHaveLength(2);
    const failed = out.components[0];
    expect(failed.component).toBe("Integrations");
    expect(failed.summary).toBe("");
    expect(failed.escapeAnalysis).toBe("");
    expect(failed.strategies).toEqual([]);
    expect(failed.defectCount).toBe(2);
    expect(failed.detectionStages).toEqual([{ stage: "integration-test", count: 3 }]);
    expect(failed.groups[0].groupKey).toBe("data-ingestion-correctness");
    // Its neighbour is unaffected.
    expect(out.components[1].summary).toMatch(/partial 207/);
  });

  it("holds at most 3 component calls in flight regardless of the extraction parallelism", async () => {
    const issues = [makeIssue("EAC-0")];
    const inner = stubComplete();
    let inFlight = 0;
    let peak = 0;
    const complete: CompletionFn = (async (opts: CompleteOpts) => {
      if (phaseOf(opts.system) !== "components") return inner(opts);
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return inner(opts);
    }) as CompletionFn;

    const out = await analyzeProductDefects(issues, {
      complete,
      parallel: 8,
      componentSlices: () =>
        Array.from({ length: 7 }, (_, i) =>
          makeComponentSlice({ component: `C${i}`, slug: `c-${i}` }),
        ),
    });
    expect(out.components).toHaveLength(7);
    expect(peak).toBe(3);
  });

  it("yields no components and no component progress when the callback is absent", async () => {
    const issues = [makeIssue("EAC-0")];
    const phases: string[] = [];
    const progress: string[] = [];
    const out = await analyzeProductDefects(issues, {
      complete: stubComplete(phases),
      onProgress: (e) => progress.push(e.phase),
    });
    expect(out.components).toEqual([]);
    expect(phases).not.toContain("components");
    expect(progress).not.toContain("components");
    // The rest of the report is unaffected.
    expect(out.groups).toHaveLength(1);
    expect(out.strategies).toHaveLength(1);
  });

  it("survives a throwing componentSlices callback, and a callback with nothing to narrate", async () => {
    const issues = [makeIssue("EAC-0")];
    const phases: string[] = [];
    const progress: string[] = [];
    const thrown = await analyzeProductDefects(issues, {
      complete: stubComplete(phases),
      componentSlices: () => {
        throw new Error("component slicing exploded");
      },
      onProgress: (e) => progress.push(e.phase),
    });
    expect(thrown.components).toEqual([]);
    expect(phases).not.toContain("components");
    expect(progress).not.toContain("components");
    // Everything the run already paid for is still returned.
    expect(thrown.groups).toHaveLength(1);
    expect(thrown.teamPlans).toEqual([]);

    const empty = await analyzeProductDefects(issues, {
      complete: stubComplete(),
      // Below the minimum defect count, nothing qualified.
      componentSlices: () => [],
      onProgress: (e) => progress.push(e.phase),
    });
    expect(empty.components).toEqual([]);
    expect(progress).not.toContain("components");
  });
});

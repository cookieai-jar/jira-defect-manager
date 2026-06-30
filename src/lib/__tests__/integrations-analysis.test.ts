import { describe, it, expect } from "vitest";
import type { JiraIssue } from "@/types/triage";
import {
  analyzeIntegrationPatterns,
  batchIssues,
  clamp,
  compactIssue,
  buildIntegrationRollups,
  emptyAnalysis,
  normalizeIntegrationInsights,
  normalizeSignals,
  normalizeSynthesis,
  normCat,
  rollupByCategory,
  slugify,
  type CompletionFn,
} from "@/lib/integrations-analysis";

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
    customers: [],
    targetedMonth: null,
    ...over,
  };
}

describe("clamp", () => {
  it("rounds and bounds", () => {
    expect(clamp(5.4, 1, 10)).toBe(5);
    expect(clamp(-3, 1, 10)).toBe(1);
    expect(clamp(99, 1, 10)).toBe(10);
  });
  it("falls back to lo on non-finite", () => {
    expect(clamp(NaN, 1, 10)).toBe(1);
    expect(clamp(Infinity, 2, 10)).toBe(10);
  });
});

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Authentication & Token Lifecycle")).toBe("authentication-token-lifecycle");
  });
  it("trims leading/trailing separators and empties to uncategorized", () => {
    expect(slugify("  !!!  ")).toBe("uncategorized");
    expect(slugify("")).toBe("uncategorized");
  });
});

describe("batchIssues", () => {
  it("splits into chunks of the given size with a remainder", () => {
    const issues = Array.from({ length: 5 }, (_, i) => makeIssue(`I-${i}`));
    const batches = batchIssues(issues, 2);
    expect(batches.map((b) => b.length)).toEqual([2, 2, 1]);
  });
  it("handles empty input", () => {
    expect(batchIssues([], 8)).toEqual([]);
  });
  it("coerces a non-positive size to 1", () => {
    const issues = [makeIssue("A"), makeIssue("B")];
    expect(batchIssues(issues, 0).length).toBe(2);
  });
});

describe("compactIssue", () => {
  it("emits valid JSON containing the key and caps comments to the last 4", () => {
    const comments = Array.from({ length: 6 }, (_, i) => ({
      id: String(i),
      author: "u",
      body: "x".repeat(2000),
      created: "2026-01-0" + (i + 1) + "T00:00:00.000Z",
      updated: "2026-01-0" + (i + 1) + "T00:00:00.000Z",
    }));
    const json = compactIssue(makeIssue("EAC-1", { comments }));
    const parsed = JSON.parse(json);
    expect(parsed.key).toBe("EAC-1");
    expect(parsed.lastComments).toHaveLength(4);
    expect(parsed.lastComments[0].body.length).toBeLessThanOrEqual(900);
    expect(parsed.commentCount).toBe(6);
  });
});

describe("normalizeSignals", () => {
  const batch = [makeIssue("A-1"), makeIssue("A-2")];

  it("returns one signal per ticket, matched by key", () => {
    const raw = [
      {
        issueKey: "A-2",
        integration: "Okta",
        failureMode: "Token refresh",
        symptom: "401 after 1h",
        suspectedRootCause: "stale token",
        errorSignatures: ["401 Unauthorized"],
        category: "Auth",
        severityScore: 7,
      },
    ];
    const signals = normalizeSignals(raw, batch);
    expect(signals).toHaveLength(2);
    const a2 = signals.find((s) => s.issueKey === "A-2")!;
    expect(a2.integration).toBe("Okta");
    expect(a2.severityScore).toBe(7);
    expect(a2.category).toBe("Auth");
  });

  it("fills safe defaults for tickets the model omitted", () => {
    const signals = normalizeSignals([], batch);
    const a1 = signals.find((s) => s.issueKey === "A-1")!;
    expect(a1.integration).toBeNull();
    expect(a1.failureMode).toBe("Unclassified");
    expect(a1.symptom).toBe("Summary for A-1"); // falls back to ticket summary
    expect(a1.suspectedRootCause).toBe("Undetermined");
    expect(a1.category).toBe("Uncategorized");
    expect(a1.severityScore).toBe(5);
  });

  it("clamps severity and caps error signatures at 8", () => {
    const raw = [
      {
        issueKey: "A-1",
        severityScore: 50,
        errorSignatures: Array.from({ length: 20 }, (_, i) => `e${i}`),
      },
    ];
    const a1 = normalizeSignals(raw, batch).find((s) => s.issueKey === "A-1")!;
    expect(a1.severityScore).toBe(10);
    expect(a1.errorSignatures).toHaveLength(8);
  });

  it("tolerates non-array raw input", () => {
    expect(normalizeSignals(null, batch)).toHaveLength(2);
    expect(normalizeSignals({ nope: true }, batch)).toHaveLength(2);
  });
});

function sig(key: string, category: string, integration: string | null = null, symptom = "") {
  return {
    issueKey: key,
    integration,
    failureMode: "",
    symptom,
    suspectedRootCause: "",
    errorSignatures: [],
    category,
    severityScore: 5,
  };
}

describe("normalizeSynthesis", () => {
  const signals = [
    sig("A-1", "Auth", "Okta"),
    sig("A-2", "Auth", "Okta"),
    sig("A-3", "Sync", "Snowflake"),
    sig("A-4", "Sync", null),
  ];

  it("derives membership/counts locally, merges raw categories, computes share", () => {
    const raw = {
      executiveSummary: "summary",
      categories: [
        {
          name: "Authentication",
          description: "auth issues",
          mergesRawCategories: ["Auth"],
          rootCauses: [
            { title: "stale token", explanation: "x", exampleIssueKeys: ["A-1", "NOPE-1"], contributingFactors: ["clock skew"] },
          ],
        },
      ],
      hardening: [],
    };
    const out = normalizeSynthesis(raw, signals);
    const auth = out.categories.find((c) => c.name === "Authentication")!;
    expect(auth.issueKeys.sort()).toEqual(["A-1", "A-2"]); // from local grouping
    expect(auth.ticketCount).toBe(2);
    expect(auth.share).toBe(50); // 2 of 4
    expect(auth.key).toBe("authentication");
    expect(auth.topIntegrations).toEqual(["Okta"]); // computed from signals
    expect(auth.rootCauses[0].issueKeys).toEqual(["A-1"]); // invalid key removed
  });

  it("keeps raw categories the model didn't place as their own categories", () => {
    const raw = { categories: [{ name: "Authentication", mergesRawCategories: ["Auth"] }] };
    const out = normalizeSynthesis(raw, signals);
    const sync = out.categories.find((c) => c.name === "Sync")!;
    expect(sync).toBeDefined(); // leftover, never lost
    expect(sync.ticketCount).toBe(2);
    expect(sync.topIntegrations).toEqual(["Snowflake"]);
  });

  it("merges multiple raw categories into one canonical category", () => {
    const raw = { categories: [{ name: "Everything", mergesRawCategories: ["Auth", "Sync"] }] };
    const out = normalizeSynthesis(raw, signals);
    expect(out.categories).toHaveLength(1);
    expect(out.categories[0].ticketCount).toBe(4);
    expect(out.categories[0].share).toBe(100);
  });

  it("counts each ticket once — first canonical to claim a raw category wins", () => {
    const raw = {
      categories: [
        { name: "First", mergesRawCategories: ["Auth"] },
        { name: "Second", mergesRawCategories: ["Auth"] },
      ],
    };
    const out = normalizeSynthesis(raw, signals);
    expect(out.categories.find((c) => c.name === "First")!.ticketCount).toBe(2);
    expect(out.categories.find((c) => c.name === "Second")).toBeUndefined(); // empty → dropped
  });

  it("falls back to local grouping when synthesis is empty/garbage", () => {
    const out = normalizeSynthesis(null, signals);
    expect(out.executiveSummary).toBe("");
    const names = out.categories.map((c) => c.name).sort();
    expect(names).toEqual(["Auth", "Sync"]);
    const total = out.categories.reduce((n, c) => n + c.ticketCount, 0);
    expect(total).toBe(4); // every ticket still represented
  });

  it("sorts categories by ticket volume descending", () => {
    const many = [sig("B-1", "Big"), sig("B-2", "Big"), sig("B-3", "Big"), sig("S-1", "Small")];
    const out = normalizeSynthesis({}, many);
    expect(out.categories.map((c) => c.name)).toEqual(["Big", "Small"]);
  });

  it("splits hardening by owner, normalizes owner aliases, and clamps enums", () => {
    const raw = {
      categories: [],
      hardening: [
        { title: "Dev fix", owner: "developer", effort: "high", priority: "now" },
        { title: "QE coverage", owner: "QE", effort: "bogus", priority: "someday" },
        { title: "Test fixtures", owner: "Quality Engineering", effort: "low", priority: "later" },
        { title: "", owner: "developer" }, // dropped: empty title
      ],
    };
    const out = normalizeSynthesis(raw, signals);
    expect(out.developerHardening.map((s) => s.title)).toEqual(["Dev fix"]);
    expect(out.developerHardening[0].effort).toBe("high");
    expect(out.developerHardening[0].priority).toBe("now");

    const qaTitles = out.qaHardening.map((s) => s.title).sort();
    expect(qaTitles).toEqual(["QE coverage", "Test fixtures"]);
    const qe = out.qaHardening.find((s) => s.title === "QE coverage")!;
    expect(qe.effort).toBe("medium"); // fallback
    expect(qe.priority).toBe("next"); // fallback
  });

  it("sorts hardening within an owner by priority now→next→later", () => {
    const raw = {
      categories: [],
      hardening: [
        { title: "later one", owner: "developer", priority: "later" },
        { title: "now one", owner: "developer", priority: "now" },
        { title: "next one", owner: "developer", priority: "next" },
      ],
    };
    const out = normalizeSynthesis(raw, signals);
    expect(out.developerHardening.map((s) => s.title)).toEqual(["now one", "next one", "later one"]);
  });

  it("yields empty categories and hardening when there are no signals at all", () => {
    const out = normalizeSynthesis(null, []);
    expect(out.categories).toEqual([]);
    expect(out.developerHardening).toEqual([]);
    expect(out.qaHardening).toEqual([]);
  });
});

describe("normCat", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normCat("  Auth   &  Tokens ")).toBe("auth & tokens");
    expect(normCat("AUTH & TOKENS")).toBe(normCat("auth & tokens"));
  });
});

describe("rollupByCategory", () => {
  const signals = [
    sig("A-1", "Auth", "Okta", "401 after 1h"),
    sig("A-2", "auth", "Okta", "token expired"), // case-variant groups together
    sig("A-3", "Sync", "Snowflake"),
  ];

  it("groups case-insensitively, counts, and ranks integrations", () => {
    const rollups = rollupByCategory(signals);
    expect(rollups.map((r) => r.count)).toEqual([2, 1]); // Auth(2) then Sync(1)
    const auth = rollups[0];
    expect(auth.count).toBe(2);
    expect(auth.integrations).toEqual(["Okta"]);
    expect(auth.samples.length).toBe(2);
  });

  it("caps samples per category", () => {
    const many = Array.from({ length: 20 }, (_, i) => sig(`X-${i}`, "Sync"));
    const rollups = rollupByCategory(many, 5);
    expect(rollups[0].count).toBe(20);
    expect(rollups[0].samples.length).toBe(5);
  });
});

describe("emptyAnalysis", () => {
  it("differentiates zero-tickets from zero-signal", () => {
    expect(emptyAnalysis(0).executiveSummary).toMatch(/No tickets matched/);
    expect(emptyAnalysis(5).executiveSummary).toMatch(/No analyzable signal/);
    expect(emptyAnalysis(5).totalTickets).toBe(5);
    expect(emptyAnalysis(5).integrationInsights).toEqual([]);
  });
});

describe("buildIntegrationRollups", () => {
  const signals = [
    sig("T-1", "Authentication", "Okta"),
    sig("T-2", "Sync", "Okta"),
    sig("T-3", "Authentication", "AWS"),
    sig("T-4", "Schema", "Databricks"), // not a strategic integration → excluded
  ];
  const categories = [
    { name: "Authentication", issueKeys: ["T-1", "T-3"] },
    { name: "Sync", issueKeys: ["T-2"] },
  ];

  it("groups only strategic integrations, then by category, with counts/keys", () => {
    const rollups = buildIntegrationRollups(signals, categories);
    const okta = rollups.find((r) => r.key === "okta")!;
    expect(okta.label).toBe("Okta");
    expect(okta.ticketCount).toBe(2);
    expect(okta.issueKeys.sort()).toEqual(["T-1", "T-2"]);
    const cats = okta.categories.map((c) => c.category).sort();
    expect(cats).toEqual(["Authentication", "Sync"]);
    // Databricks excluded entirely.
    expect(rollups.find((r) => r.label === "Databricks")).toBeUndefined();
  });

  it("sorts integrations by volume, sorts categories by volume, caps categories & samples", () => {
    const oktaAuth = Array.from({ length: 15 }, (_, i) => `O-${i}`);
    const many = [
      ...oktaAuth.map((k) => sig(k, "Auth", "Okta")),
      sig("O-x", "Sync", "Okta"),
      sig("A-1", "Auth", "AWS"),
    ];
    const cats = [
      { name: "Authentication", issueKeys: [...oktaAuth, "A-1"] },
      { name: "Sync", issueKeys: ["O-x"] },
    ];
    const rollups = buildIntegrationRollups(many, cats, 1, 5); // maxCategories=1, samples=5
    expect(rollups[0].key).toBe("okta"); // 16 > 1
    expect(rollups[0].categories).toHaveLength(1); // capped to the largest
    expect(rollups[0].categories[0].category).toBe("Authentication");
    expect(rollups[0].categories[0].samples.length).toBe(5);
  });
});

describe("normalizeIntegrationInsights", () => {
  const rollups = [
    {
      key: "okta",
      label: "Okta",
      ticketCount: 3,
      issueKeys: ["T-1", "T-2", "T-3"],
      topCategories: ["Authentication", "Sync"],
      categories: [
        { category: "Authentication", ticketCount: 2, samples: [] },
        { category: "Sync", ticketCount: 1, samples: [] },
      ],
    },
    {
      key: "aws",
      label: "AWS",
      ticketCount: 1,
      issueKeys: ["T-4"],
      topCategories: ["Sync"],
      categories: [{ category: "Sync", ticketCount: 1, samples: [] }],
    },
  ];

  it("merges per-category narrative onto every rollup, matched by key then category", () => {
    const raw = [
      {
        integration: "okta",
        summary: "Token lifecycle issues",
        categories: [
          { category: "Authentication", analysis: "tokens expire", actions: ["serialize refresh", "401 retry"] },
        ],
      },
    ];
    const out = normalizeIntegrationInsights(raw, rollups);
    expect(out).toHaveLength(2); // one per rollup
    const okta = out.find((i) => i.key === "okta")!;
    expect(okta.ticketCount).toBe(3); // authoritative from rollup
    expect(okta.summary).toBe("Token lifecycle issues");
    expect(okta.categoryInsights).toHaveLength(1); // only Authentication had narrative
    expect(okta.categoryInsights[0].category).toBe("Authentication");
    expect(okta.categoryInsights[0].actions).toHaveLength(2);
    // aws had no model entry → empty narrative but still present with counts
    const aws = out.find((i) => i.key === "aws")!;
    expect(aws.summary).toBe("");
    expect(aws.categoryInsights).toEqual([]);
    expect(aws.ticketCount).toBe(1);
  });

  it("matches integration when the model echoes a label/alias instead of the key", () => {
    const raw = [{ integration: "Amazon Web Services", summary: "S3 perms" }];
    const out = normalizeIntegrationInsights(raw, rollups);
    expect(out.find((i) => i.key === "aws")!.summary).toBe("S3 perms");
  });

  it("matches categories case-insensitively and caps actions", () => {
    const raw = [
      {
        integration: "okta",
        categories: [
          { category: "authentication", analysis: "x", actions: Array.from({ length: 9 }, (_, i) => `a${i}`) },
        ],
      },
    ];
    const okta = normalizeIntegrationInsights(raw, rollups).find((i) => i.key === "okta")!;
    expect(okta.categoryInsights[0].category).toBe("Authentication"); // rollup casing preserved
    expect(okta.categoryInsights[0].actions.length).toBeLessThanOrEqual(5);
  });

  it("tolerates non-array raw input", () => {
    const out = normalizeIntegrationInsights(null, rollups);
    expect(out).toHaveLength(2);
    expect(out.every((i) => i.summary === "" && i.categoryInsights.length === 0)).toBe(true);
  });
});

describe("analyzeIntegrationPatterns (orchestration with injected LLM)", () => {
  function fakeComplete(): CompletionFn {
    return (async (opts) => {
      if (opts.system.includes("STRATEGIC")) {
        // Per-integration / per-category insight phase.
        return [
          {
            integration: "okta",
            summary: "Token lifecycle problems dominate.",
            categories: [
              { category: "Authentication", analysis: "concurrent refreshes collide", actions: ["Serialize token refresh"] },
            ],
          },
        ] as unknown as T_;
      }
      if (opts.system.includes("retrospective")) {
        return {
          executiveSummary: "We found auth and sync issues.",
          categories: [
            { name: "Authentication", mergesRawCategories: ["Authentication"], rootCauses: [] },
          ],
          hardening: [
            { title: "Add token refresh retry", owner: "developer", effort: "medium", priority: "now" },
            { title: "Add auth contract tests", owner: "quality-engineering", effort: "low", priority: "next" },
          ],
        } as unknown as T_;
      }
      const keys = [...opts.user.matchAll(/"key":"([^"]+)"/g)].map((m) => m[1]);
      return keys.map((k) => ({
        issueKey: k,
        integration: "Okta",
        failureMode: "Token refresh",
        symptom: "401",
        suspectedRootCause: "stale token",
        errorSignatures: ["401"],
        category: "Authentication",
        severityScore: 6,
      })) as unknown as T_;
    }) as CompletionFn;
  }

  it("returns the empty analysis for zero issues without calling the model", async () => {
    let calls = 0;
    const inner = fakeComplete();
    const complete: CompletionFn = (async (opts) => {
      calls++;
      return inner(opts);
    }) as CompletionFn;
    const out = await analyzeIntegrationPatterns([], { complete });
    expect(out.analyzedTickets).toBe(0);
    expect(calls).toBe(0);
  });

  it("runs extract + synthesize and assembles the report", async () => {
    const issues = Array.from({ length: 5 }, (_, i) => makeIssue(`INT-${i}`));
    const phases: string[] = [];
    const out = await analyzeIntegrationPatterns(issues, {
      complete: fakeComplete(),
      batchSize: 2,
      parallel: 2,
      onProgress: (e) => phases.push(e.phase),
    });

    expect(out.totalTickets).toBe(5);
    expect(out.analyzedTickets).toBe(5);
    expect(out.signals).toHaveLength(5);
    expect(out.categories).toHaveLength(1);
    expect(out.categories[0].ticketCount).toBe(5);
    expect(out.categories[0].share).toBe(100);
    expect(out.developerHardening.map((s) => s.title)).toContain("Add token refresh retry");
    expect(out.qaHardening.map((s) => s.title)).toContain("Add auth contract tests");
    expect(phases).toContain("extract");
    expect(phases).toContain("synthesize");
    expect(phases).toContain("integrations");
    // Per-integration deep analysis is attached (all 5 tickets were Okta).
    expect(out.integrationInsights).toHaveLength(1);
    const okta = out.integrationInsights[0];
    expect(okta.key).toBe("okta");
    expect(okta.ticketCount).toBe(5);
    expect(okta.summary).toBe("Token lifecycle problems dominate.");
    expect(okta.categoryInsights[0].category).toBe("Authentication");
    expect(okta.categoryInsights[0].actions).toContain("Serialize token refresh");
  });

  it("is resilient to an extraction batch throwing — still yields default signals", async () => {
    const issues = Array.from({ length: 4 }, (_, i) => makeIssue(`INT-${i}`));
    let calls = 0;
    const flaky: CompletionFn = (async (opts) => {
      if (!opts.system.includes("retrospective")) {
        calls++;
        if (calls === 1) throw new Error("overloaded");
        const keys = [...opts.user.matchAll(/"key":"([^"]+)"/g)].map((m) => m[1]);
        return keys.map((k) => ({ issueKey: k, category: "Sync", severityScore: 5 })) as unknown as T_;
      }
      return { executiveSummary: "ok", categories: [], hardening: [] } as unknown as T_;
    }) as CompletionFn;

    const out = await analyzeIntegrationPatterns(issues, { complete: flaky, batchSize: 2, parallel: 1 });
    // All 4 tickets still represented despite one failed batch.
    expect(out.signals).toHaveLength(4);
    expect(out.analyzedTickets).toBe(4);
  });
});

// Helper alias so the fake completion can return loosely-typed payloads.
type T_ = unknown;

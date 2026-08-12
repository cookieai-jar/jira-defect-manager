import { describe, it, expect } from "vitest";
import {
  AGING_THRESHOLD_DAYS,
  bucketByMonth,
  computeDefectMetrics,
  looksReworked,
  mean,
  median,
  monthEndMs,
  monthKey,
  monthStartMs,
  monthsBack,
  openAt,
  parseMs,
  pctOf,
  percentile,
  round1,
} from "../defect-metrics";
import type { DefectMetric } from "@/types/product-defects";
import type { CodeCorrelation, DefectSignal } from "@/types/product-defects";
import type { JiraIssue } from "@/types/triage";

const DAY_MS = 86_400_000;

/** Fixed clock: 10 Feb 2026, midday UTC. Every assertion below is anchored here. */
const NOW = new Date("2026-02-10T12:00:00.000Z");

function issue(key: string, over: Partial<JiraIssue> = {}): JiraIssue {
  return {
    key,
    summary: `s ${key}`,
    status: "Backlog",
    statusCategory: "new",
    priority: "P2",
    issueType: "Bug",
    reporter: null,
    assignee: "Dev A",
    created: "2026-01-05T00:00:00.000Z",
    updated: "2026-01-05T00:00:00.000Z",
    resolved: null,
    labels: [],
    components: [],
    url: `https://j/${key}`,
    description: null,
    comments: [],
    parent: null,
    customers: ["Acme"],
    targetedMonth: null,
    ...over,
  };
}

function signal(issueKey: string, over: Partial<DefectSignal> = {}): DefectSignal {
  return {
    issueKey,
    area: "Okta connector",
    failureMode: "Pagination token expiry",
    symptom: "Sync stalls",
    suspectedRootCause: "Token not refreshed",
    triggerCondition: "Long sync",
    trigger: "data-scale",
    escapeReason: "No long-running sync test",
    detectionStage: "integration-test",
    errorSignatures: [],
    category: "sync",
    subCategory: "pagination",
    isRegression: false,
    customerImpact: "Stale data",
    severityScore: 5,
    preventability: 5,
    ...over,
  };
}

function get(metrics: DefectMetric[], key: string): DefectMetric {
  const m = metrics.find((x) => x.key === key);
  if (!m) throw new Error(`no metric ${key}; have ${metrics.map((x) => x.key).join(", ")}`);
  return m;
}

function values(m: DefectMetric): Array<[string, number | null]> {
  return m.series.map((p) => [p.period, p.value]);
}

/**
 * Core population, anchored to NOW. Months in the 3-month window:
 *   2025-12 → D1, D2 created   2026-01 → D3 created   2026-02 → D4, D5, D6 created
 */
const CORE: JiraIssue[] = [
  issue("D1", {
    priority: "P0",
    created: "2025-12-05T00:00:00.000Z",
    resolved: "2025-12-15T00:00:00.000Z",
    statusCategory: "done",
    status: "Done",
    updated: "2025-12-15T00:00:00.000Z",
  }),
  issue("D2", {
    priority: "P2",
    created: "2025-12-20T00:00:00.000Z",
    resolved: "2026-01-10T00:00:00.000Z",
    statusCategory: "done",
    status: "Done",
    updated: "2026-01-10T00:00:00.000Z",
  }),
  issue("D3", { priority: "P1", created: "2026-01-05T00:00:00.000Z" }),
  issue("D4", { priority: "P3", created: "2026-02-02T00:00:00.000Z" }),
  issue("D5", { priority: "P2", created: "2026-02-04T00:00:00.000Z" }),
  issue("D6", { priority: "P2", created: "2026-02-06T00:00:00.000Z" }),
];

const CORE_OPTS = { now: NOW, months: 3 };

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("monthKey", () => {
  it("buckets in UTC with no off-by-one at month boundaries", () => {
    expect(monthKey("2025-12-31T23:59:59.999Z")).toBe("2025-12");
    expect(monthKey("2026-01-01T00:00:00.000Z")).toBe("2026-01");
    expect(monthKey("2026-01-31T23:59:59.999Z")).toBe("2026-01");
    expect(monthKey("2026-02-01T00:00:00.000Z")).toBe("2026-02");
  });

  it("zero-pads and accepts Date / epoch ms / ISO alike", () => {
    expect(monthKey(new Date("2026-09-15T00:00:00.000Z"))).toBe("2026-09");
    expect(monthKey(Date.parse("2026-09-15T00:00:00.000Z"))).toBe("2026-09");
    expect(monthKey("2026-10-01T00:00:00.000Z")).toBe("2026-10");
  });

  it("returns an empty string for garbage rather than NaN-ing a bucket key", () => {
    expect(monthKey("not a date")).toBe("");
  });
});

describe("monthsBack", () => {
  it("crosses a year boundary correctly and includes the current month", () => {
    expect(monthsBack(new Date("2026-01-15T00:00:00.000Z"), 3)).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
    ]);
  });

  it("returns exactly `months` periods, oldest first, ending at now's month", () => {
    const p = monthsBack(NOW, 13);
    expect(p).toHaveLength(13);
    expect(p[0]).toBe("2025-02");
    expect(p[12]).toBe("2026-02");
    expect([...p].sort()).toEqual(p); // already ascending
  });

  it("handles a January `now` (month index 0 rolling back a year)", () => {
    expect(monthsBack(new Date("2026-01-01T00:00:00.000Z"), 2)).toEqual(["2025-12", "2026-01"]);
  });

  it("never returns fewer than one period", () => {
    expect(monthsBack(NOW, 0)).toEqual(["2026-02"]);
  });
});

describe("monthStartMs / monthEndMs", () => {
  it("spans exactly the month, end-inclusive to the millisecond", () => {
    expect(new Date(monthStartMs("2026-01")).toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(new Date(monthEndMs("2026-01")).toISOString()).toBe("2026-01-31T23:59:59.999Z");
    // December → the end must roll into the next YEAR, not month 13.
    expect(new Date(monthEndMs("2025-12")).toISOString()).toBe("2025-12-31T23:59:59.999Z");
    // Leap February.
    expect(new Date(monthEndMs("2024-02")).toISOString()).toBe("2024-02-29T23:59:59.999Z");
  });
});

describe("bucketByMonth", () => {
  it("groups by UTC month and drops undated items", () => {
    const out = bucketByMonth(
      [
        { d: "2026-01-31T23:59:59.999Z" },
        { d: "2026-02-01T00:00:00.000Z" },
        { d: "2026-02-28T00:00:00.000Z" },
        { d: null },
        { d: "nonsense" },
      ],
      (x) => x.d,
    );
    expect(out.get("2026-01")).toHaveLength(1);
    expect(out.get("2026-02")).toHaveLength(2);
    expect(out.size).toBe(2);
  });
});

describe("mean / median / percentile", () => {
  it("diverge on a skewed set", () => {
    const skewed = [1, 1, 1, 1, 96];
    expect(mean(skewed)).toBe(20);
    expect(median(skewed)).toBe(1);
  });

  it("median averages the middle pair on an even set", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("is order-independent", () => {
    expect(median([96, 1, 1, 1, 1])).toBe(1);
  });

  it("returns null on an empty set instead of 0 or NaN", () => {
    expect(mean([])).toBeNull();
    expect(median([])).toBeNull();
    expect(percentile([], 90)).toBeNull();
  });

  it("interpolates percentiles and clamps p", () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([0, 10], 90)).toBe(9);
    expect(percentile([1, 2, 3], 0)).toBe(1);
    expect(percentile([1, 2, 3], 100)).toBe(3);
    expect(percentile([1, 2, 3], 999)).toBe(3);
    expect(percentile([7], 42)).toBe(7);
  });
});

describe("round1 / pctOf", () => {
  it("rounds percentages to one decimal", () => {
    expect(pctOf(1, 3)).toBe(33.3);
    expect(pctOf(2, 3)).toBe(66.7);
    expect(pctOf(5, 16)).toBe(31.3); // 31.25 → half up
    expect(pctOf(1, 8)).toBe(12.5);
    expect(pctOf(1, 2)).toBe(50);
    expect(pctOf(3, 3)).toBe(100);
  });

  it("distinguishes a real zero from a missing denominator", () => {
    expect(pctOf(0, 5)).toBe(0);
    expect(pctOf(0, 0)).toBeNull();
    expect(pctOf(3, 0)).toBeNull();
  });

  it("round1 is stable on binary-fraction hazards", () => {
    expect(round1(1.05)).toBe(1.1);
    expect(round1(2.675)).toBe(2.7);
    expect(round1(-1.25)).toBe(-1.3);
    expect(round1(10)).toBe(10);
  });
});

describe("parseMs / openAt", () => {
  it("parseMs is null-safe", () => {
    expect(parseMs(null)).toBeNull();
    expect(parseMs("")).toBeNull();
    expect(parseMs("garbage")).toBeNull();
    expect(parseMs("2026-01-01T00:00:00.000Z")).toBe(Date.parse("2026-01-01T00:00:00.000Z"));
  });

  it("counts a ticket open when created <= t and (unresolved or resolved > t)", () => {
    const t = monthEndMs("2026-01");
    expect(openAt(t - DAY_MS, null, t)).toBe(true);
    expect(openAt(t, null, t)).toBe(true); // created exactly at the boundary counts
    expect(openAt(t + 1, null, t)).toBe(false); // created after the boundary does not
    expect(openAt(t - DAY_MS, t, t)).toBe(false); // resolved exactly at the boundary is closed
    expect(openAt(t - DAY_MS, t + 1, t)).toBe(true); // resolved just after is still open
  });
});

// ---------------------------------------------------------------------------
// 1. Inflow, and the partial-month / current / baseline convention
// ---------------------------------------------------------------------------

describe("customer-defect-inflow", () => {
  const m = get(computeDefectMetrics(CORE, CORE_OPTS), "customer-defect-inflow");

  it("backfills a real monthly series from ticket history", () => {
    expect(values(m)).toEqual([
      ["2025-12", 2],
      ["2026-01", 1],
      ["2026-02", 3],
    ]);
  });

  it("reports the last COMPLETE month as `current`, never the partial one", () => {
    expect(m.series[m.series.length - 1].period).toBe("2026-02"); // partial, still charted
    expect(m.current).toBe(1); // January, the last complete month
    expect(m.current).not.toBe(3);
  });

  it("baselines against the complete months before `current`", () => {
    expect(m.baseline).toBe(2); // December only
  });

  it("has no baseline when there is no history before the current month", () => {
    // months=2 → [2026-01, 2026-02]: January is `current`, nothing precedes it.
    const short = get(computeDefectMetrics(CORE, { now: NOW, months: 2 }), "customer-defect-inflow");
    expect(short.current).toBe(1);
    expect(short.baseline).toBeNull();
  });

  it("is a down-good defects/month metric sourced from jira", () => {
    expect(m.unit).toBe("defects/month");
    expect(m.direction).toBe("down-good");
    expect(m.source).toBe("jira");
    expect(m.automated).toBe(true);
    expect(m.cadence).toBe("monthly");
  });
});

describe("null vs zero", () => {
  // Extend coverage back to September so October/November are genuinely empty
  // months, while July/August predate any data at all.
  const withSeptember = [
    ...CORE,
    issue("S1", {
      created: "2025-09-10T00:00:00.000Z",
      resolved: "2025-09-20T00:00:00.000Z",
      statusCategory: "done",
      status: "Done",
      updated: "2025-09-20T00:00:00.000Z",
    }),
  ];
  const metrics = computeDefectMetrics(withSeptember, { now: NOW, months: 8 });

  it("emits null before the population starts and 0 for an empty month inside it", () => {
    expect(values(get(metrics, "customer-defect-inflow"))).toEqual([
      ["2025-07", null], // no data at all yet → unknowable
      ["2025-08", null],
      ["2025-09", 1],
      ["2025-10", 0], // real zero: we were watching, nothing was filed
      ["2025-11", 0],
      ["2025-12", 2],
      ["2026-01", 1],
      ["2026-02", 3],
    ]);
  });

  it("applies the same rule to the point-in-time backlog", () => {
    expect(values(get(metrics, "open-customer-defect-backlog"))).toEqual([
      ["2025-07", null],
      ["2025-08", null],
      ["2025-09", 0], // S1 opened and closed inside September
      ["2025-10", 0],
      ["2025-11", 0],
      ["2025-12", 1],
      ["2026-01", 1],
      ["2026-02", 4],
    ]);
  });

  it("emits null (not 0) for a ratio period with an empty denominator", () => {
    const ttr = get(metrics, "time-to-resolve-mean");
    const feb = ttr.series.find((p) => p.period === "2026-02")!;
    expect(feb.value).toBeNull();
    expect(feb.denominator).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Point-in-time backlog
// ---------------------------------------------------------------------------

describe("open-customer-defect-backlog", () => {
  const m = get(computeDefectMetrics(CORE, CORE_OPTS), "open-customer-defect-backlog");

  it("reconstructs each month-end from created/resolved, not from today's open set", () => {
    // D2 is created in Dec and resolved mid-January: open at end of Dec, gone by end of Jan.
    expect(values(m)).toEqual([
      ["2025-12", 1],
      ["2026-01", 1],
      ["2026-02", 4],
    ]);
    expect(m.current).toBe(1);
  });

  it("counts a ticket resolved on the last millisecond of the month as closed", () => {
    const edge = [
      issue("E1", {
        created: "2026-01-02T00:00:00.000Z",
        resolved: "2026-01-31T23:59:59.999Z",
        statusCategory: "done",
        status: "Done",
        updated: "2026-01-31T23:59:59.999Z",
      }),
      issue("E2", {
        created: "2026-01-02T00:00:00.000Z",
        resolved: "2026-02-01T00:00:00.000Z",
        statusCategory: "done",
        status: "Done",
        updated: "2026-02-01T00:00:00.000Z",
      }),
    ];
    const s = get(
      computeDefectMetrics(edge, { now: NOW, months: 2 }),
      "open-customer-defect-backlog",
    ).series;
    expect(s.find((p) => p.period === "2026-01")!.value).toBe(1); // only E2 still open
  });

  it("clamps the partial month's snapshot to `now` rather than to a future month end", () => {
    const later = [...CORE, issue("LATE", { created: "2026-02-20T00:00:00.000Z" })];
    const s = get(
      computeDefectMetrics(later, CORE_OPTS),
      "open-customer-defect-backlog",
    ).series;
    // LATE is created after NOW (10 Feb) so it must not appear in February's point.
    expect(s.find((p) => p.period === "2026-02")!.value).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// 3. Time to resolve
// ---------------------------------------------------------------------------

describe("time-to-resolve", () => {
  it("buckets by RESOLUTION month, not creation month", () => {
    const meanM = get(computeDefectMetrics(CORE, CORE_OPTS), "time-to-resolve-mean");
    // D1: created 5 Dec, resolved 15 Dec → 10d, lands in December.
    // D2: created 20 Dec, resolved 10 Jan → 21d, lands in JANUARY despite being filed in December.
    expect(values(meanM)).toEqual([
      ["2025-12", 10],
      ["2026-01", 21],
      ["2026-02", null],
    ]);
    expect(meanM.current).toBe(21);
    expect(meanM.baseline).toBe(10);
    expect(meanM.unit).toBe("days");
  });

  it("mean and median diverge on a skewed month", () => {
    // Four one-day fixes plus one 96-day slog, all resolved in January.
    const skewed: JiraIssue[] = [
      ...["Q1", "Q2", "Q3", "Q4"].map((k) =>
        issue(k, {
          created: "2026-01-01T00:00:00.000Z",
          resolved: "2026-01-02T00:00:00.000Z",
          statusCategory: "done",
          status: "Done",
          updated: "2026-01-02T00:00:00.000Z",
        }),
      ),
      issue("Q5", {
        created: "2025-10-01T00:00:00.000Z",
        resolved: "2026-01-05T00:00:00.000Z",
        statusCategory: "done",
        status: "Done",
        updated: "2026-01-05T00:00:00.000Z",
      }),
    ];
    const metrics = computeDefectMetrics(skewed, { now: NOW, months: 2 });
    const jan = (key: string) =>
      get(metrics, key).series.find((p) => p.period === "2026-01")!;
    expect(jan("time-to-resolve-mean").value).toBe(20); // (1+1+1+1+96)/5
    expect(jan("time-to-resolve-median").value).toBe(1);
    expect(jan("time-to-resolve-mean").denominator).toBe(5);
  });

  it("rounds day counts to one decimal", () => {
    const partialDay = [
      issue("H1", {
        created: "2026-01-01T00:00:00.000Z",
        resolved: "2026-01-02T06:00:00.000Z", // 1.25 days
        statusCategory: "done",
        status: "Done",
        updated: "2026-01-02T06:00:00.000Z",
      }),
    ];
    const s = get(
      computeDefectMetrics(partialDay, { now: NOW, months: 2 }),
      "time-to-resolve-mean",
    ).series;
    expect(s.find((p) => p.period === "2026-01")!.value).toBe(1.3);
  });
});

// ---------------------------------------------------------------------------
// 4. P0/P1 share
// ---------------------------------------------------------------------------

describe("p0-p1-share", () => {
  it("is a rounded percentage of the month's inflow", () => {
    const m = get(computeDefectMetrics(CORE, CORE_OPTS), "p0-p1-share");
    expect(values(m)).toEqual([
      ["2025-12", 50], // D1 is P0 of {D1, D2}
      ["2026-01", 100], // D3 is P1 of {D3}
      ["2026-02", 0], // real zero: three defects, none P0/P1
    ]);
    expect(m.unit).toBe("%");
    expect(m.direction).toBe("down-good");
  });

  it("rounds to one decimal and carries numerator/denominator", () => {
    const three = [
      issue("R1", { priority: "P0", created: "2026-01-03T00:00:00.000Z" }),
      issue("R2", { priority: "P2", created: "2026-01-04T00:00:00.000Z" }),
      issue("R3", { priority: "P3", created: "2026-01-05T00:00:00.000Z" }),
    ];
    const p = get(computeDefectMetrics(three, { now: NOW, months: 2 }), "p0-p1-share").series.find(
      (x) => x.period === "2026-01",
    )!;
    expect(p.value).toBe(33.3);
    expect(p.numerator).toBe(1);
    expect(p.denominator).toBe(3);
  });

  it("understands JIRA's priority aliases and unset priorities", () => {
    const aliased = [
      issue("A1", { priority: "Highest", created: "2026-01-03T00:00:00.000Z" }),
      issue("A2", { priority: "High", created: "2026-01-04T00:00:00.000Z" }),
      issue("A3", { priority: null, created: "2026-01-05T00:00:00.000Z" }),
      issue("A4", { priority: "Low", created: "2026-01-06T00:00:00.000Z" }),
    ];
    const p = get(computeDefectMetrics(aliased, { now: NOW, months: 2 }), "p0-p1-share").series.find(
      (x) => x.period === "2026-01",
    )!;
    expect(p.value).toBe(50); // Highest→P0, High→P1
  });
});

// ---------------------------------------------------------------------------
// 5. Aging
// ---------------------------------------------------------------------------

describe("aging-over-90d-share", () => {
  const janEnd = monthEndMs("2026-01");

  it("treats exactly 90 days as not-yet-aging and one millisecond older as aging", () => {
    const boundary = [
      issue("EXACT", { created: new Date(janEnd - AGING_THRESHOLD_DAYS * DAY_MS).toISOString() }),
      issue("OLDER", {
        created: new Date(janEnd - AGING_THRESHOLD_DAYS * DAY_MS - 1).toISOString(),
      }),
    ];
    const p = get(
      computeDefectMetrics(boundary, { now: NOW, months: 2 }),
      "aging-over-90d-share",
    ).series.find((x) => x.period === "2026-01")!;
    expect(p.numerator).toBe(1);
    expect(p.denominator).toBe(2);
    expect(p.value).toBe(50);
  });

  it("only considers tickets open at the period end", () => {
    const mixed = [
      // Old but resolved before January ended → excluded from both numerator and denominator.
      issue("CLOSED", {
        created: "2025-06-01T00:00:00.000Z",
        resolved: "2026-01-15T00:00:00.000Z",
        statusCategory: "done",
        status: "Done",
        updated: "2026-01-15T00:00:00.000Z",
      }),
      issue("FRESH", { created: "2026-01-20T00:00:00.000Z" }),
    ];
    const p = get(
      computeDefectMetrics(mixed, { now: NOW, months: 2 }),
      "aging-over-90d-share",
    ).series.find((x) => x.period === "2026-01")!;
    expect(p.denominator).toBe(1);
    expect(p.value).toBe(0);
  });

  it("is null when nothing was open in the period", () => {
    const p = get(
      computeDefectMetrics(
        [
          issue("Z1", {
            created: "2026-01-02T00:00:00.000Z",
            resolved: "2026-01-03T00:00:00.000Z",
            statusCategory: "done",
            status: "Done",
            updated: "2026-01-03T00:00:00.000Z",
          }),
        ],
        { now: NOW, months: 2 },
      ),
      "aging-over-90d-share",
    ).series.find((x) => x.period === "2026-01")!;
    expect(p.value).toBeNull();
    expect(p.denominator).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Reopen / churn proxy
// ---------------------------------------------------------------------------

describe("reopen-churn-rate", () => {
  const rec = (over: Partial<JiraIssue>) =>
    issue("X", {
      created: "2026-01-01T00:00:00.000Z",
      resolved: "2026-01-05T00:00:00.000Z",
      statusCategory: "done",
      status: "Done",
      updated: "2026-01-05T00:00:00.000Z",
      ...over,
    });

  const rework = (i: JiraIssue) =>
    looksReworked({
      key: i.key,
      createdMs: Date.parse(i.created),
      resolvedMs: i.resolved ? Date.parse(i.resolved) : null,
      updatedMs: Date.parse(i.updated),
      lastCommentMs: i.comments.length ? Date.parse(i.comments[0].created) : null,
      statusCategory: i.statusCategory,
      priority: null,
    });

  it("never flags an unresolved ticket", () => {
    expect(rework(rec({ resolved: null, statusCategory: "indeterminate" }))).toBe(false);
  });

  it("flags a ticket that has a resolution date but is no longer Done", () => {
    expect(rework(rec({ statusCategory: "indeterminate", status: "In Progress" }))).toBe(true);
  });

  it("flags a late edit long after resolution", () => {
    expect(rework(rec({ updated: "2026-01-20T00:00:00.000Z" }))).toBe(true);
  });

  it("does not flag an edit inside the slack window", () => {
    expect(rework(rec({ updated: "2026-01-10T00:00:00.000Z" }))).toBe(false);
  });

  it("does not flag a late edit that a comment explains", () => {
    const withComment = rec({
      updated: "2026-01-20T00:00:00.000Z",
      comments: [
        {
          id: "1",
          author: "Someone",
          body: "any update?",
          created: "2026-01-20T00:00:00.000Z",
          updated: "2026-01-20T00:00:00.000Z",
        },
      ],
    });
    expect(rework(withComment)).toBe(false);
  });

  it("reports the share of a resolution month's tickets that look reworked", () => {
    const pop = [
      rec({ key: "C1" }), // clean
      rec({ key: "C2", statusCategory: "indeterminate", status: "Reopened" }), // rolled back
      rec({ key: "C3", updated: "2026-01-20T00:00:00.000Z" }), // late edit
      rec({
        key: "C4",
        updated: "2026-01-20T00:00:00.000Z",
        comments: [
          {
            id: "1",
            author: "A",
            body: "ping",
            created: "2026-01-20T00:00:00.000Z",
            updated: "2026-01-20T00:00:00.000Z",
          },
        ],
      }), // explained by a comment
    ];
    const p = get(
      computeDefectMetrics(pop, { now: NOW, months: 2 }),
      "reopen-churn-rate",
    ).series.find((x) => x.period === "2026-01")!;
    expect(p.numerator).toBe(2);
    expect(p.denominator).toBe(4);
    expect(p.value).toBe(50);
  });

  it("says out loud in its definition that it is an approximation", () => {
    const m = get(computeDefectMetrics(CORE, CORE_OPTS), "reopen-churn-rate");
    expect(m.definition).toMatch(/APPROXIMATION/);
    expect(m.definition).toMatch(/changelog/i);
    expect(m.howToMeasure).toMatch(/changelog/i);
  });
});

// ---------------------------------------------------------------------------
// 7. Concentration (needs groups)
// ---------------------------------------------------------------------------

describe("defect-concentration-top3", () => {
  const pop = ["A", "B", "C", "D", "E", "F", "G", "H"].map((k) =>
    issue(k, { created: "2026-01-05T00:00:00.000Z" }),
  );
  const groups = [
    { key: "alpha", name: "Alpha", issueKeys: ["A", "B", "C"] },
    { key: "beta", name: "Beta", issueKeys: ["D", "E"] },
    { key: "gamma", name: "Gamma", issueKeys: ["F"] },
    { key: "delta", name: "Delta", issueKeys: ["G"] },
  ];

  it("is a non-automated placeholder when groups are absent", () => {
    const m = get(computeDefectMetrics(pop, { now: NOW, months: 2 }), "defect-concentration-top3");
    expect(m.automated).toBe(false);
    expect(m.series).toEqual([]);
    expect(m.current).toBeNull();
    expect(m.baseline).toBeNull();
    expect(m.howToMeasure).not.toBe("");
  });

  it("reports the top-3 share of classified defects and excludes unclassified ones", () => {
    const m = get(
      computeDefectMetrics(pop, { now: NOW, months: 2, groups }),
      "defect-concentration-top3",
    );
    expect(m.automated).toBe(true);
    const p = m.series.find((x) => x.period === "2026-01")!;
    // Top 3 by size = alpha(3) + beta(2) + gamma(1) = 6 of the 7 classified; H is unclassified.
    expect(p.numerator).toBe(6);
    expect(p.denominator).toBe(7);
    expect(p.value).toBe(85.7);
    expect(m.relatedGroupKeys).toEqual(["alpha", "beta", "gamma"]);
  });
});

// ---------------------------------------------------------------------------
// 8-10. Signal-dependent metrics
// ---------------------------------------------------------------------------

describe("signal-dependent metrics", () => {
  const pop = ["S1", "S2", "S3", "S4"].map((k) =>
    issue(k, { created: "2026-01-05T00:00:00.000Z" }),
  );
  const signals = [
    signal("S1", { detectionStage: "integration-test", isRegression: true, preventability: 8 }),
    signal("S2", { detectionStage: "integration-test", preventability: 7 }),
    signal("S3", { detectionStage: "unit-test", preventability: 6 }),
    signal("S4", { detectionStage: "not-preventable", preventability: 5 }),
  ];
  const opts = { now: NOW, months: 2, signals };

  it("emits one placeholder for the escape mix when signals are absent", () => {
    const metrics = computeDefectMetrics(pop, { now: NOW, months: 2 });
    const m = get(metrics, "escape-stage-mix");
    expect(m.automated).toBe(false);
    expect(m.series).toEqual([]);
    expect(metrics.filter((x) => x.key.startsWith("escape-stage-"))).toHaveLength(1);
  });

  it("emits one metric per major detection stage when signals are present", () => {
    const metrics = computeDefectMetrics(pop, opts);
    const keys = metrics.filter((m) => m.key.startsWith("escape-stage-")).map((m) => m.key);
    expect(keys).toEqual(["escape-stage-integration-test", "escape-stage-unit-test"]);
    expect(metrics.find((m) => m.key === "escape-stage-mix")).toBeUndefined();
    // "not-preventable" is not a gate we could have closed, so it gets no metric.
    expect(keys).not.toContain("escape-stage-not-preventable");
  });

  it("computes each stage's share of the month's analyzed defects", () => {
    const metrics = computeDefectMetrics(pop, opts);
    const integ = get(metrics, "escape-stage-integration-test").series.find(
      (p) => p.period === "2026-01",
    )!;
    expect(integ.numerator).toBe(2);
    expect(integ.denominator).toBe(4);
    expect(integ.value).toBe(50);
    const unit = get(metrics, "escape-stage-unit-test").series.find((p) => p.period === "2026-01")!;
    expect(unit.value).toBe(25);
  });

  it("caps the escape-stage metrics at the three biggest stages", () => {
    const many = ["M1", "M2", "M3", "M4", "M5"].map((k) =>
      issue(k, { created: "2026-01-05T00:00:00.000Z" }),
    );
    const stages = ["code-review", "unit-test", "e2e-test", "scale-test", "manual-qa"] as const;
    const metrics = computeDefectMetrics(many, {
      now: NOW,
      months: 2,
      signals: many.map((i, idx) => signal(i.key, { detectionStage: stages[idx] })),
    });
    expect(metrics.filter((m) => m.key.startsWith("escape-stage-"))).toHaveLength(3);
  });

  it("regression rate is a placeholder without signals and a real series with them", () => {
    const without = get(computeDefectMetrics(pop, { now: NOW, months: 2 }), "regression-rate");
    expect(without.automated).toBe(false);
    expect(without.series).toEqual([]);
    expect(without.current).toBeNull();

    const with_ = get(computeDefectMetrics(pop, opts), "regression-rate");
    expect(with_.automated).toBe(true);
    const p = with_.series.find((x) => x.period === "2026-01")!;
    expect(p.numerator).toBe(1);
    expect(p.denominator).toBe(4);
    expect(p.value).toBe(25);
    expect(with_.unit).toBe("%");
    expect(with_.direction).toBe("down-good");
  });

  it("mean preventability averages the month's scores", () => {
    const without = get(computeDefectMetrics(pop, { now: NOW, months: 2 }), "mean-preventability");
    expect(without.automated).toBe(false);

    const m = get(computeDefectMetrics(pop, opts), "mean-preventability");
    const p = m.series.find((x) => x.period === "2026-01")!;
    expect(p.value).toBe(6.5); // (8+7+6+5)/4
    expect(m.unit).toBe("score (1-10)");
    expect(m.direction).toBe("down-good");
  });

  it("ignores signals for tickets outside the population", () => {
    const m = get(
      computeDefectMetrics(pop, {
        now: NOW,
        months: 2,
        signals: [...signals, signal("GHOST", { detectionStage: "integration-test" })],
      }),
      "escape-stage-integration-test",
    );
    expect(m.series.find((p) => p.period === "2026-01")!.denominator).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// 11-12. Correlation-dependent metrics
// ---------------------------------------------------------------------------

function correlationFixture(): CodeCorrelation {
  const commit = (sha: string, date: string, touchesTests: boolean) => ({
    sha,
    subject: `fix ${sha}`,
    date,
    files: ["pkg/sync/paginator.go"],
    touchesTests,
  });
  const sha1 = commit("sha1", "2026-01-05T00:00:00.000Z", true);
  const sha2 = commit("sha2", "2026-01-10T00:00:00.000Z", false);
  const sha3 = commit("sha3", "2026-01-20T00:00:00.000Z", false);
  const sha0 = commit("sha0", "2025-12-10T00:00:00.000Z", true);
  return {
    repoPath: "/repo",
    repoHead: "head",
    totalTickets: 4,
    linkedTickets: 4,
    linkRate: 100,
    fileHotspots: [
      {
        path: "pkg/sync/paginator.go",
        defectCount: 2,
        issueKeys: ["K1", "K2"],
        teams: ["@veza/integrations"],
        fileCount: 1,
      },
    ],
    areaHotspots: [],
    byTeam: [],
    links: [
      { issueKey: "K0", commits: [sha0], teams: [], files: [] },
      { issueKey: "K1", commits: [sha1], teams: [], files: [] },
      // sha1 is shared with K1 — it must be counted once, not twice.
      { issueKey: "K2", commits: [sha1, sha2], teams: [], files: [] },
      { issueKey: "K3", commits: [sha3], teams: [], files: [] },
    ],
    fixesWithTests: 2,
    fixesWithoutTests: 2,
    byGroup: [],
  };
}

describe("correlation-dependent metrics", () => {
  const pop = [
    issue("K0", { created: "2025-12-02T00:00:00.000Z" }),
    issue("K1", { created: "2026-01-03T00:00:00.000Z" }),
    issue("K2", { created: "2026-01-04T00:00:00.000Z" }),
    issue("K3", { created: "2026-01-06T00:00:00.000Z" }),
  ];

  it("returns non-automated placeholders when correlation is null", () => {
    for (const explicitlyNull of [{ correlation: null }, {}]) {
      const metrics = computeDefectMetrics(pop, { now: NOW, months: 3, ...explicitlyNull });
      for (const key of ["fix-with-test-rate", "hotspot-concentration-top10"]) {
        const m = get(metrics, key);
        expect(m.automated).toBe(false);
        expect(m.series).toEqual([]);
        expect(m.current).toBeNull();
        expect(m.baseline).toBeNull();
        expect(m.source).toBe("code");
        expect(m.howToMeasure.length).toBeGreaterThan(0);
      }
    }
  });

  it("computes the fix-with-test rate by commit month, de-duplicated by sha", () => {
    const m = get(
      computeDefectMetrics(pop, { now: NOW, months: 3, correlation: correlationFixture() }),
      "fix-with-test-rate",
    );
    expect(m.automated).toBe(true);
    expect(m.direction).toBe("up-good"); // the one metric where up is the good direction
    expect(values(m)).toEqual([
      ["2025-12", 100], // sha0
      ["2026-01", 33.3], // sha1 tested, sha2 + sha3 not — sha1 counted once
      ["2026-02", null], // no fix commits yet this month
    ]);
    expect(m.current).toBe(33.3);
    expect(m.baseline).toBe(100);
  });

  it("computes hotspot concentration over code-linked defects by creation month", () => {
    const m = get(
      computeDefectMetrics(pop, { now: NOW, months: 3, correlation: correlationFixture() }),
      "hotspot-concentration-top10",
    );
    const jan = m.series.find((p) => p.period === "2026-01")!;
    expect(jan.numerator).toBe(2); // K1, K2 live in the hot file
    expect(jan.denominator).toBe(3); // K1, K2, K3 are linked to code
    expect(jan.value).toBe(66.7);
    expect(m.series.find((p) => p.period === "2025-12")!.value).toBe(0); // K0 is linked but cold
  });

  it("falls back to a placeholder when the correlation found no hotspots", () => {
    const empty = { ...correlationFixture(), fileHotspots: [], areaHotspots: [] };
    const m = get(
      computeDefectMetrics(pop, { now: NOW, months: 3, correlation: empty }),
      "hotspot-concentration-top10",
    );
    expect(m.automated).toBe(false);
    expect(m.series).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Proposed (non-automated) metrics
// ---------------------------------------------------------------------------

describe("proposed metrics", () => {
  const metrics = computeDefectMetrics(CORE, CORE_OPTS);
  const proposed = [
    "defect-escape-rate",
    "mean-time-to-detect",
    "hotspot-test-coverage",
    "ci-flake-rate",
    "scale-test-tenant-coverage",
  ];

  it("proposes a short, high-signal list we cannot compute today", () => {
    for (const key of proposed) {
      const m = get(metrics, key);
      expect(m.automated).toBe(false);
      expect(m.series).toEqual([]);
      expect(m.current).toBeNull();
      expect(m.howToMeasure.length).toBeGreaterThan(40);
      expect(m.definition.length).toBeGreaterThan(40);
    }
    expect(proposed.length).toBeLessThanOrEqual(6);
  });

  it("keeps unit/direction coherent on the proposals", () => {
    expect(get(metrics, "defect-escape-rate").direction).toBe("down-good");
    expect(get(metrics, "hotspot-test-coverage").direction).toBe("up-good");
    expect(get(metrics, "mean-time-to-detect").unit).toBe("days");
    expect(get(metrics, "scale-test-tenant-coverage").cadence).toBe("quarterly");
  });
});

// ---------------------------------------------------------------------------
// Whole-report invariants (what the runner relies on)
// ---------------------------------------------------------------------------

describe("computeDefectMetrics contract", () => {
  it("is deterministic given a fixed now", () => {
    const a = computeDefectMetrics(CORE, CORE_OPTS);
    const b = computeDefectMetrics([...CORE].reverse(), CORE_OPTS);
    expect(a).toEqual(b);
  });

  it("is side-effect free — it does not mutate its inputs", () => {
    const pop = CORE.map((i) => ({ ...i }));
    const groups = [{ key: "g", name: "G", issueKeys: ["D1", "D2"] }];
    const snapshot = JSON.stringify({ pop, groups });
    computeDefectMetrics(pop, { ...CORE_OPTS, groups });
    expect(JSON.stringify({ pop, groups })).toBe(snapshot);
  });

  it("emits unique keys", () => {
    const keys = computeDefectMetrics(CORE, CORE_OPTS).map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("defaults to a 13-month window inclusive of the current partial month", () => {
    const m = get(computeDefectMetrics(CORE, { now: NOW }), "customer-defect-inflow");
    expect(m.series).toHaveLength(13);
    expect(m.series[0].period).toBe("2025-02");
    expect(m.series[12].period).toBe("2026-02");
  });

  it("survives an empty population without throwing or emitting fake zeros", () => {
    const metrics = computeDefectMetrics([], { now: NOW, months: 3 });
    const inflow = get(metrics, "customer-defect-inflow");
    expect(inflow.series.every((p) => p.value === null)).toBe(true);
    expect(inflow.current).toBeNull();
    expect(inflow.baseline).toBeNull();
  });

  it("skips tickets with an unparseable created date rather than bucketing them as NaN", () => {
    const metrics = computeDefectMetrics([...CORE, issue("BAD", { created: "" })], CORE_OPTS);
    expect(get(metrics, "customer-defect-inflow").series.map((p) => p.value)).toEqual([2, 1, 3]);
  });

  it("every automated metric documents the partial-month convention", () => {
    for (const m of computeDefectMetrics(CORE, CORE_OPTS).filter((x) => x.automated)) {
      expect(m.definition).toMatch(/still-incomplete month/);
      expect(m.name.length).toBeGreaterThan(0);
      expect(["%", "days", "defects", "defects/month", "score (1-10)"]).toContain(m.unit);
    }
  });

  it("flags exactly one point as partial — the last — on every automated metric", () => {
    for (const m of computeDefectMetrics(CORE, CORE_OPTS).filter((x) => x.automated)) {
      const flagged = m.series.filter((p) => p.partial);
      expect(flagged).toHaveLength(1);
      expect(flagged[0]).toBe(m.series[m.series.length - 1]);
      expect(flagged[0].period).toBe("2026-02");
      // Complete periods leave the field unset rather than carrying `false`.
      for (const p of m.series.slice(0, -1)) {
        expect(p.partial).toBeUndefined();
        expect("partial" in p).toBe(false);
      }
      // `current` is the last COMPLETE period, never the flagged one.
      expect(m.current).toBe(m.series[m.series.length - 2].value);
    }
  });

  it("flags the partial point at the default 13-month depth too", () => {
    const m = get(computeDefectMetrics(CORE, { now: NOW }), "customer-defect-inflow");
    expect(m.series.filter((p) => p.partial).map((p) => p.period)).toEqual(["2026-02"]);
    expect(m.series[12].value).toBe(3); // partial February, charted
    expect(m.current).toBe(1); // complete January
  });

  it("only snapshots complete-period values (the runner's persistence filter)", () => {
    const snapshotted = computeDefectMetrics(CORE, CORE_OPTS).filter(
      (m) => m.automated && m.current != null,
    );
    expect(snapshotted.map((m) => m.key).sort()).toEqual(
      [
        "aging-over-90d-share",
        "customer-defect-inflow",
        "open-customer-defect-backlog",
        "p0-p1-share",
        "reopen-churn-rate",
        "time-to-resolve-mean",
        "time-to-resolve-median",
      ].sort(),
    );
    // Each snapshotted value is January's (the last complete month), never February's.
    for (const m of snapshotted) {
      const lastComplete = m.series[m.series.length - 2];
      expect(lastComplete.period).toBe("2026-01");
      expect(m.current).toBe(lastComplete.value);
    }
  });

  it("behaves the same on the runner's two calls, only richer on the second", () => {
    const correlation = correlationFixture();
    const first = computeDefectMetrics(CORE, { ...CORE_OPTS, correlation });
    const second = computeDefectMetrics(CORE, {
      ...CORE_OPTS,
      correlation,
      signals: [signal("D3", { detectionStage: "code-review" })],
      groups: [{ key: "g1", name: "G1", issueKeys: ["D1", "D3"] }],
    });
    const automated = (ms: DefectMetric[]) => ms.filter((m) => m.automated).map((m) => m.key);
    // The first call already produces the ticket-history and code metrics...
    expect(automated(first)).toContain("customer-defect-inflow");
    expect(automated(first)).toContain("fix-with-test-rate");
    // ...and the second adds the signal/group-dependent ones.
    expect(automated(first)).not.toContain("regression-rate");
    expect(automated(second)).toContain("regression-rate");
    expect(automated(second)).toContain("mean-preventability");
    expect(automated(second)).toContain("defect-concentration-top3");
    expect(automated(second)).toContain("escape-stage-code-review");
    // Shared metrics are byte-identical across the two calls.
    expect(get(first, "customer-defect-inflow")).toEqual(get(second, "customer-defect-inflow"));
    expect(get(first, "fix-with-test-rate")).toEqual(get(second, "fix-with-test-rate"));
  });
});

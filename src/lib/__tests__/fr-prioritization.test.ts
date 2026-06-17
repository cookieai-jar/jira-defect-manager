import { describe, it, expect } from "vitest";
import {
  buildMatrix,
  cohortCuts,
  classifyQuadrant,
  QUADRANT_ORDER,
  type Row,
} from "@/lib/fr-prioritization";
import type { JiraIssue, TicketAnalysis } from "@/types/triage";

/** Minimal Row fixture — only the fields the prioritization logic reads matter. */
function row(
  key: string,
  temperatureScore: number,
  severityScore: number,
  overrides: Partial<TicketAnalysis> = {},
): Row {
  const issue = { key, summary: `Summary ${key}` } as unknown as JiraIssue;
  const analysis = {
    issueKey: key,
    temperatureScore,
    severityScore,
    status: "active",
    ...overrides,
  } as unknown as TicketAnalysis;
  return { ...analysis, issue };
}

/** Flatten every cell's keys, in QUADRANT_ORDER, for membership assertions. */
function allKeys(m: ReturnType<typeof buildMatrix>): string[] {
  return QUADRANT_ORDER.flatMap((q) => m.cells[q].rows.map((r) => r.issueKey));
}

describe("cohortCuts", () => {
  it("selects the top 40% on each axis, rounding up via Math.ceil", () => {
    // 5 rows → ceil(0.4 * 5) = 2 high on each axis.
    const rows = [
      row("A", 10, 1),
      row("B", 8, 2),
      row("C", 6, 9),
      row("D", 4, 7),
      row("E", 2, 3),
    ];
    const cuts = cohortCuts(rows);
    // Demand top 2 by temperatureScore: A(10), B(8) → cut = 8.
    expect([...cuts.highDemand].sort()).toEqual(["A", "B"]);
    expect(cuts.demandCut).toBe(8);
    // Value top 2 by severityScore: C(9), D(7) → cut = 7.
    expect([...cuts.highValue].sort()).toEqual(["C", "D"]);
    expect(cuts.valueCut).toBe(7);
  });

  it("breaks ties at the cut by issueKey ascending", () => {
    // 5 rows, ceil = 2 high. Three rows tie at score 5 for demand: B, C, D.
    // Sorted by issueKey ASC, B and C win the two high slots; D does not.
    const rows = [
      row("A", 9, 1),
      row("B", 5, 1),
      row("C", 5, 1),
      row("D", 5, 1),
      row("E", 1, 1),
    ];
    const cuts = cohortCuts(rows);
    expect([...cuts.highDemand].sort()).toEqual(["A", "B"]);
    expect(cuts.demandCut).toBe(5);
    expect(cuts.highDemand.has("C")).toBe(false);
    expect(cuts.highDemand.has("D")).toBe(false);
  });

  it("returns null cuts and empty sets for an empty cohort", () => {
    const cuts = cohortCuts([]);
    expect(cuts.demandCut).toBeNull();
    expect(cuts.valueCut).toBeNull();
    expect(cuts.highDemand.size).toBe(0);
    expect(cuts.highValue.size).toBe(0);
  });
});

describe("classifyQuadrant", () => {
  it("classifies all four corners relative to the cohort", () => {
    // Two clearly-high rows and two clearly-low on each axis.
    const rows = [
      row("BUILD", 10, 10),
      row("STRAT", 1, 9),
      row("NICE", 9, 1),
      row("DEPRI", 2, 2),
      row("FILL1", 5, 5),
      row("FILL2", 5, 5),
    ];
    const cuts = cohortCuts(rows);
    expect(classifyQuadrant(row("BUILD", 10, 10), cuts)).toBe("build-now");
    expect(classifyQuadrant(row("STRAT", 1, 9), cuts)).toBe("strategic-bet");
    expect(classifyQuadrant(row("NICE", 9, 1), cuts)).toBe("nice-to-have");
    expect(classifyQuadrant(row("DEPRI", 2, 2), cuts)).toBe("deprioritize");
  });
});

describe("buildMatrix", () => {
  it("excludes resolved rows from cells, total, and the cohort cuts", () => {
    const m = buildMatrix([
      row("A", 9, 9),
      row("B", 100, 100, { status: "resolved" }), // would dominate cuts if counted
      row("C", 2, 2),
    ]);
    // Only 2 open rows; ceil(0.4 * 2) = 1 high per axis.
    expect(m.total).toBe(2);
    expect(m.cells["build-now"].rows.map((r) => r.issueKey)).toEqual(["A"]);
    expect(m.cells["deprioritize"].rows.map((r) => r.issueKey)).toEqual(["C"]);
    expect(allKeys(m)).not.toContain("B");
    // Cuts reflect the open cohort, not the resolved row's 100s.
    expect(m.demandCut).toBe(9);
    expect(m.valueCut).toBe(9);
  });

  it("produces a usable spread via the top-40% split (5 rows → 2 high/axis)", () => {
    const m = buildMatrix([
      row("A", 10, 10), // high demand, high value → build-now
      row("B", 9, 9), // high demand, high value → build-now
      row("C", 8, 2), // high demand? demand rank 3 → not high
      row("D", 2, 8), // value rank 3 → not high
      row("E", 1, 1),
    ]);
    expect(m.total).toBe(5);
    // demand top 2: A(10), B(9); value top 2: A(10), B(9).
    expect(m.demandCut).toBe(9);
    expect(m.valueCut).toBe(9);
    expect(m.cells["build-now"].rows.map((r) => r.issueKey)).toEqual(["A", "B"]);
    // Everyone else lands low/low.
    expect(m.cells["deprioritize"].rows.map((r) => r.issueKey).sort()).toEqual([
      "C",
      "D",
      "E",
    ]);
  });

  it("handles all-equal scores by taking the top ceil(0.4N) by issueKey", () => {
    // 5 identical rows. ceil(0.4 * 5) = 2 high on each axis. Both axes pick the
    // same two lowest issueKeys (A, B), so those two are build-now and the rest
    // are deprioritize.
    const rows = ["A", "B", "C", "D", "E"].map((k) => row(k, 5, 5));
    const m = buildMatrix(rows);
    expect(m.demandCut).toBe(5);
    expect(m.valueCut).toBe(5);
    expect(m.cells["build-now"].rows.map((r) => r.issueKey).sort()).toEqual([
      "A",
      "B",
    ]);
    expect(m.cells["nice-to-have"].rows).toEqual([]);
    expect(m.cells["strategic-bet"].rows).toEqual([]);
    expect(m.cells["deprioritize"].rows.map((r) => r.issueKey).sort()).toEqual([
      "C",
      "D",
      "E",
    ]);
  });

  it("sorts each cell by combined (temperature + severity) descending", () => {
    // All three are high/high in a 3-row cohort: ceil(0.4 * 3) = 2 high, but
    // make all three high by giving them dominant scores relative to fillers.
    const m = buildMatrix([
      row("low", 7, 7), // combined 14
      row("high", 10, 10), // combined 20
      row("mid", 9, 9), // combined 18
      row("f1", 1, 1),
      row("f2", 1, 1),
    ]);
    // ceil(0.4 * 5) = 2 high per axis → high, mid are build-now.
    expect(m.cells["build-now"].rows.map((r) => r.issueKey)).toEqual([
      "high",
      "mid",
    ]);
  });

  it("handles empty input gracefully (null cuts, empty cells)", () => {
    const m = buildMatrix([]);
    expect(m.total).toBe(0);
    expect(m.demandCut).toBeNull();
    expect(m.valueCut).toBeNull();
    for (const q of QUADRANT_ORDER) {
      expect(m.cells[q].rows).toEqual([]);
      expect(m.cells[q].quadrant).toBe(q);
      expect(typeof m.cells[q].label).toBe("string");
    }
  });
});

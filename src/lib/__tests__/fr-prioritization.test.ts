import { describe, it, expect } from "vitest";
import {
  buildMatrix,
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

describe("classifyQuadrant", () => {
  it("classifies all four corners", () => {
    expect(classifyQuadrant(row("A", 9, 9))).toBe("build-now"); // high demand, high value
    expect(classifyQuadrant(row("B", 2, 9))).toBe("strategic-bet"); // low demand, high value
    expect(classifyQuadrant(row("C", 9, 2))).toBe("nice-to-have"); // high demand, low value
    expect(classifyQuadrant(row("D", 2, 2))).toBe("deprioritize"); // low demand, low value
  });

  it("treats exactly 7 on each axis as high (inclusive boundary)", () => {
    expect(classifyQuadrant(row("A", 7, 7))).toBe("build-now");
    expect(classifyQuadrant(row("B", 6, 7))).toBe("strategic-bet"); // demand just below
    expect(classifyQuadrant(row("C", 7, 6))).toBe("nice-to-have"); // value just below
    expect(classifyQuadrant(row("D", 6, 6))).toBe("deprioritize");
  });
});

describe("buildMatrix", () => {
  it("excludes resolved rows from cells and total", () => {
    const m = buildMatrix([
      row("A", 9, 9),
      row("B", 8, 8, { status: "resolved" }),
      row("C", 2, 2),
    ]);
    expect(m.total).toBe(2);
    expect(m.cells["build-now"].rows.map((r) => r.issueKey)).toEqual(["A"]);
    expect(m.cells["deprioritize"].rows.map((r) => r.issueKey)).toEqual(["C"]);
    const allKeys = QUADRANT_ORDER.flatMap((q) =>
      m.cells[q].rows.map((r) => r.issueKey),
    );
    expect(allKeys).not.toContain("B");
  });

  it("sorts each cell by combined (temperature + severity) descending", () => {
    const m = buildMatrix([
      row("low", 7, 7), // combined 14
      row("high", 9, 10), // combined 19
      row("mid", 8, 8), // combined 16
    ]);
    expect(m.cells["build-now"].rows.map((r) => r.issueKey)).toEqual([
      "high",
      "mid",
      "low",
    ]);
  });

  it("places every non-resolved row in exactly one cell", () => {
    const rows = [
      row("A", 9, 9),
      row("B", 3, 9),
      row("C", 9, 3),
      row("D", 3, 3),
    ];
    const m = buildMatrix(rows);
    expect(m.total).toBe(4);
    const counts = QUADRANT_ORDER.map((q) => m.cells[q].rows.length);
    expect(counts).toEqual([1, 1, 1, 1]);
  });

  it("handles empty input gracefully", () => {
    const m = buildMatrix([]);
    expect(m.total).toBe(0);
    for (const q of QUADRANT_ORDER) {
      expect(m.cells[q].rows).toEqual([]);
      expect(m.cells[q].quadrant).toBe(q);
      expect(typeof m.cells[q].label).toBe("string");
    }
  });
});

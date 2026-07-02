import { describe, it, expect } from "vitest";
import {
  parseTargetedMonth,
  classifyDependency,
  monthKeyOf,
  buildCommittedRoadmap,
  missingEacFields,
  type RoadmapIssueInput,
} from "@/lib/fr-roadmap";
import type { RoadmapDependency } from "@/types/triage";

describe("parseTargetedMonth", () => {
  it("parses MMM 'YY with straight or curly apostrophe", () => {
    expect(parseTargetedMonth("Jul '26")).toEqual({ key: "2026-07", year: 2026, monthIndex: 6 });
    expect(parseTargetedMonth("Jul ’26")).toEqual({ key: "2026-07", year: 2026, monthIndex: 6 });
    expect(parseTargetedMonth("Aug '25")).toEqual({ key: "2025-08", year: 2025, monthIndex: 7 });
  });
  it("parses full month + 4-digit year", () => {
    expect(parseTargetedMonth("July 2026")?.key).toBe("2026-07");
  });
  it("returns null for empty / unparseable", () => {
    expect(parseTargetedMonth(null)).toBeNull();
    expect(parseTargetedMonth("")).toBeNull();
    expect(parseTargetedMonth("someday")).toBeNull();
    expect(parseTargetedMonth("Foo '26")).toBeNull();
  });
});

describe("classifyDependency", () => {
  it("flags an unresolved blocker for 'is blocked by' / 'depends on'", () => {
    expect(classifyDependency("is blocked by", false)).toEqual({ direction: "blocked-by", isBlocker: true });
    expect(classifyDependency("is blocked by", true)).toEqual({ direction: "blocked-by", isBlocker: false }); // done
    expect(classifyDependency("depends on", false)).toEqual({ direction: "depends-on", isBlocker: true });
  });
  it("outward 'blocks' / 'is depended on by' is not a blocker for the source", () => {
    expect(classifyDependency("blocks", false)).toEqual({ direction: "blocks", isBlocker: false });
    expect(classifyDependency("is depended on by", false)).toEqual({ direction: "blocks", isBlocker: false });
  });
  it("falls back to relates", () => {
    expect(classifyDependency("relates to", false)).toEqual({ direction: "relates", isBlocker: false });
  });
});

describe("monthKeyOf", () => {
  it("formats the UTC year-month", () => {
    expect(monthKeyOf(Date.UTC(2026, 5, 15))).toBe("2026-06");
  });
});

describe("missingEacFields", () => {
  it("flags each unset planning field", () => {
    expect(missingEacFields({ dueDate: null, originalEstimate: null, sprint: null })).toEqual([
      "Due Date",
      "Original Estimate",
      "Sprint",
    ]);
  });
  it("treats an empty sprint array and 0 estimate as missing", () => {
    expect(missingEacFields({ dueDate: "2026-07-01", originalEstimate: 0, sprint: [] })).toEqual([
      "Original Estimate",
      "Sprint",
    ]);
  });
  it("returns [] when all are set", () => {
    expect(missingEacFields({ dueDate: "2026-07-01", originalEstimate: 28800, sprint: [{ id: 5 }] })).toEqual([]);
  });
});

function dep(over: Partial<RoadmapDependency> = {}): RoadmapDependency {
  return {
    key: "X-1",
    summary: "blocker",
    status: "In Progress",
    statusCategory: "indeterminate",
    direction: "blocked-by",
    url: "https://j/browse/X-1",
    isBlocker: true,
    ...over,
  };
}
function fr(over: Partial<RoadmapIssueInput> = {}): RoadmapIssueInput {
  return {
    key: "FR-1",
    summary: "fr",
    status: "Open",
    statusCategory: "new",
    issueType: "Improvement",
    parentKey: null,
    targetedMonth: "Jul '26",
    dependencies: [],
    missingFields: [],
    ...over,
  };
}

describe("buildCommittedRoadmap", () => {
  const now = Date.UTC(2026, 5, 1); // Jun 2026

  it("groups committed FRs by month (chronological), attaches children, tallies blockers", () => {
    const frs = [
      fr({ key: "FR-1", targetedMonth: "Jul '26", dependencies: [dep({ key: "FR-9" })] }),
      fr({ key: "FR-2", targetedMonth: "Mar '26" }),
      fr({ key: "FR-3", targetedMonth: "Jul '26" }),
      fr({ key: "FR-4", targetedMonth: "garbage" }), // dropped
    ];
    const children = [
      { ...fr({ key: "EAC-1", issueType: "Epic", parentKey: "FR-1", targetedMonth: null }), dependencies: [dep({ key: "EAC-9" })], missingFields: ["Sprint"] },
      fr({ key: "EAC-2", issueType: "Epic", parentKey: "FR-3", targetedMonth: null }),
      fr({ key: "EAC-X", issueType: "Epic", parentKey: "FR-404", targetedMonth: null }), // orphan, ignored
    ];
    const rm = buildCommittedRoadmap(frs, children, "https://j", now);

    expect(rm.months.map((m) => m.key)).toEqual(["2026-03", "2026-07"]); // chronological, garbage dropped
    const jul = rm.months.find((m) => m.key === "2026-07")!;
    expect(jul.label).toBe("Jul '26");
    expect(jul.frCount).toBe(2); // FR-1, FR-3
    expect(jul.childCount).toBe(2); // EAC-1 (FR-1), EAC-2 (FR-3)
    expect(jul.blockerCount).toBe(2); // FR-1 dep + EAC-1 dep
    expect(jul.isPast).toBe(false); // Jul'26 > Jun'26

    const mar = rm.months.find((m) => m.key === "2026-03")!;
    expect(mar.isPast).toBe(true);

    // FR-1 sorts before FR-3 (more blockers); url + child wired
    expect(jul.frs[0].key).toBe("FR-1");
    expect(jul.frs[0].url).toBe("https://j/browse/FR-1");
    expect(jul.frs[0].children[0].key).toBe("EAC-1");
    expect(jul.frs[0].blockerCount).toBe(2);

    // FR-4 has a set-but-unparseable month → surfaced in `dropped`, not silently lost
    expect(rm.dropped).toEqual([{ key: "FR-4", rawValue: "garbage" }]);

    // EAC-1 (child of FR-1) is missing Sprint → surfaced on the child + tallied up
    expect(jul.frs[0].children[0].missingFields).toEqual(["Sprint"]);
    expect(jul.frs[0].incompleteChildCount).toBe(1);
    expect(jul.incompleteChildCount).toBe(1);
  });

  it("dedupes a blocker shared between an FR and its child (counts it once)", () => {
    const frs = [fr({ key: "FR-1", dependencies: [dep({ key: "UP-1" })] })];
    const children = [{ ...fr({ key: "EAC-1", parentKey: "FR-1" }), dependencies: [dep({ key: "UP-1" })] }];
    const rm = buildCommittedRoadmap(frs, children, "https://j", now);
    expect(rm.months[0].frs[0].blockerCount).toBe(1); // same UP-1, not 2
  });

  it("returns empty months (and no dropped) when nothing is committed", () => {
    const rm = buildCommittedRoadmap([fr({ targetedMonth: null })], [], "https://j", now);
    expect(rm.months).toEqual([]);
    expect(rm.dropped).toEqual([]); // null month is not "dropped" (field unset)
  });
});

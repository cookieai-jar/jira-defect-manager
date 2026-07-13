import { describe, it, expect } from "vitest";
import {
  distribution,
  lastNDays,
  pivotTrends,
  reconstructDay,
  type SnapshotRow,
} from "../defect-trends-core";
import type { JiraIssue } from "@/types/triage";

function issue(key: string, over: Partial<JiraIssue> = {}): JiraIssue {
  return {
    key,
    summary: `s ${key}`,
    status: "Backlog",
    statusCategory: "new",
    priority: "P1",
    issueType: "Bug",
    reporter: null,
    assignee: "Dev A",
    created: "2026-06-01T00:00:00.000Z",
    updated: "2026-06-15T00:00:00.000Z",
    resolved: null,
    labels: [],
    components: [],
    url: `https://j/${key}`,
    description: null,
    comments: [],
    parent: null,
    customers: [],
    targetedMonth: null,
    ...over,
  };
}

const JULY_10 = Date.parse("2026-07-10T12:00:00.000Z");

describe("distribution", () => {
  it("emits total, priority, status, assignee, customer and sla groups", () => {
    const pts = distribution(
      [
        issue("A-1", { priority: "P1", assignee: "Dev A", customers: ["Acme"] }),
        issue("A-2", { priority: "P2", assignee: "Dev B" }),
      ],
      JULY_10,
    );
    const get = (grp: string, key: string) => pts.find((p) => p.grp === grp && p.key === key)?.count;
    expect(get("total", "open")).toBe(2);
    expect(get("priority", "P1")).toBe(1);
    expect(get("priority", "P2")).toBe(1);
    expect(get("assignee", "Dev A")).toBe(1);
    expect(get("customer", "Acme")).toBe(1);
    // both created 2026-06-01, P1 SLA fix = 28d → past SLA by mid-July
    expect(get("sla", "late")).toBe(1); // only the P1 is late; P2 fix window is 84d
  });
});

describe("reconstructDay", () => {
  const history = [
    issue("A-1", { created: "2026-06-01T00:00:00.000Z", resolved: "2026-06-20T00:00:00.000Z" }),
    issue("A-2", { created: "2026-06-10T00:00:00.000Z", resolved: null }),
    issue("A-3", { created: "2026-07-05T00:00:00.000Z", resolved: null }),
  ];
  it("counts a ticket as open only between its created and resolved dates", () => {
    // 2026-06-15: A-1 (open) + A-2 (open), A-3 not yet created
    expect(reconstructDay(history, "2026-06-15").find((p) => p.grp === "total")?.count).toBe(2);
    // 2026-06-25: A-1 resolved, A-2 open
    expect(reconstructDay(history, "2026-06-25").find((p) => p.grp === "total")?.count).toBe(1);
    // 2026-07-06: A-2 + A-3 open
    expect(reconstructDay(history, "2026-07-06").find((p) => p.grp === "total")?.count).toBe(2);
  });
  it("omits non-reconstructable groups (status)", () => {
    expect(reconstructDay(history, "2026-06-15").some((p) => p.grp === "status")).toBe(false);
  });
});

describe("lastNDays", () => {
  it("returns n ascending inclusive day strings ending today", () => {
    const days = lastNDays(Date.parse("2026-07-10T09:00:00Z"), 3);
    expect(days).toEqual(["2026-07-08", "2026-07-09", "2026-07-10"]);
  });
});

describe("pivotTrends", () => {
  it("aligns each series to the group's day axis, filling gaps with 0", () => {
    const rows: SnapshotRow[] = [
      { day: "2026-07-01", grp: "priority", key: "P1", count: 5 },
      { day: "2026-07-02", grp: "priority", key: "P1", count: 3 },
      { day: "2026-07-02", grp: "priority", key: "P0", count: 2 }, // P0 absent on day 1
    ];
    const t = pivotTrends(rows).priority;
    expect(t.days).toEqual(["2026-07-01", "2026-07-02"]);
    const p1 = t.series.find((s) => s.key === "P1")!;
    const p0 = t.series.find((s) => s.key === "P0")!;
    expect(p1.points).toEqual([5, 3]);
    expect(p0.points).toEqual([0, 2]); // gap filled
    // sorted by latest value desc → P1 (3) before P0 (2)
    expect(t.series[0].key).toBe("P1");
  });
});

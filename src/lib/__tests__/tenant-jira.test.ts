import { describe, it, expect } from "vitest";
import {
  ticketProject,
  priorityRank,
  sortByPriority,
  groupTicketsByProject,
  TICKET_PROJECTS,
} from "@/lib/tenant-jira";
import type { TenantJiraTicket } from "@/types/tenant";

function tkt(over: Partial<TenantJiraTicket> & { key: string }): TenantJiraTicket {
  return { summary: "s", status: "Open", priority: null, done: false, url: "u", ...over };
}

describe("ticketProject", () => {
  it("extracts and uppercases the project prefix", () => {
    expect(ticketProject("EAC-63783")).toBe("EAC");
    expect(ticketProject("ops-9893")).toBe("OPS");
    expect(ticketProject("FR-1")).toBe("FR");
  });
  it("returns '' for malformed keys", () => {
    expect(ticketProject("nodash")).toBe("");
    expect(ticketProject("")).toBe("");
  });
});

describe("priorityRank", () => {
  it("orders P0..P3 and Highest..Lowest, unknown/unset last", () => {
    expect(priorityRank("P0")).toBeLessThan(priorityRank("P1"));
    expect(priorityRank("Highest")).toBeLessThan(priorityRank("High"));
    expect(priorityRank("High")).toBeLessThan(priorityRank("Low"));
    expect(priorityRank(null)).toBe(99);
    expect(priorityRank("Weird")).toBe(90);
    expect(priorityRank("P0")).toBe(priorityRank("Highest")); // both rank 0
  });
});

describe("sortByPriority", () => {
  it("sorts urgent-first, tie-broken by key", () => {
    const out = sortByPriority([
      tkt({ key: "EAC-2", priority: "P3" }),
      tkt({ key: "EAC-1", priority: "P0" }),
      tkt({ key: "EAC-9", priority: null }),
      tkt({ key: "EAC-3", priority: "P0" }),
    ]);
    expect(out.map((t) => t.key)).toEqual(["EAC-1", "EAC-3", "EAC-2", "EAC-9"]);
  });
  it("does not mutate its input", () => {
    const input = [tkt({ key: "B-2", priority: "P3" }), tkt({ key: "A-1", priority: "P0" })];
    const snapshot = input.map((t) => t.key);
    sortByPriority(input);
    expect(input.map((t) => t.key)).toEqual(snapshot);
  });
});

describe("groupTicketsByProject", () => {
  const tickets = [
    tkt({ key: "EAC-1", priority: "P1" }),
    tkt({ key: "EAC-2", priority: "P0", done: true }),
    tkt({ key: "OPS-5", priority: "P2" }),
    tkt({ key: "FR-7", priority: "P3", done: true }),
    tkt({ key: "FR-8", priority: "P0" }),
    tkt({ key: "SEC-9", priority: "P1" }), // -> Other
  ];

  it("returns the three named projects in order, then Other when non-empty", () => {
    const groups = groupTicketsByProject(tickets);
    expect(groups.map((g) => g.project)).toEqual(["EAC", "OPS", "FR", "Other"]);
  });

  it("splits open vs done and sorts each by priority", () => {
    const groups = groupTicketsByProject(tickets);
    const eac = groups.find((g) => g.project === "EAC")!;
    expect(eac.open.map((t) => t.key)).toEqual(["EAC-1"]);
    expect(eac.done.map((t) => t.key)).toEqual(["EAC-2"]);
    expect(eac.total).toBe(2);

    const fr = groups.find((g) => g.project === "FR")!;
    expect(fr.open.map((t) => t.key)).toEqual(["FR-8"]); // P0 open
    expect(fr.done.map((t) => t.key)).toEqual(["FR-7"]); // P3 done
  });

  it("routes non-EAC/OPS/FR tickets to Other", () => {
    const other = groupTicketsByProject(tickets).find((g) => g.project === "Other")!;
    expect(other.open.map((t) => t.key)).toEqual(["SEC-9"]);
  });

  it("keeps the named projects even when empty, and omits Other when empty", () => {
    const groups = groupTicketsByProject([tkt({ key: "EAC-1", priority: "P1" })]);
    expect(groups.map((g) => g.project)).toEqual([...TICKET_PROJECTS]);
    const ops = groups.find((g) => g.project === "OPS")!;
    expect(ops.total).toBe(0);
    expect(ops.open).toEqual([]);
  });
});

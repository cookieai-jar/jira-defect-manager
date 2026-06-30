import { describe, it, expect } from "vitest";
import { extractCustomers, CUSTOMER_FIELD, parseDependencies, type RawIssueLink } from "@/lib/jira";

describe("extractCustomers (customfield_10044 multi-select)", () => {
  it("pulls .value from each option (real JIRA shape)", () => {
    // Shape verified live via the Phase-0 spike.
    const raw = [
      { self: "https://veza.atlassian.net/rest/api/3/customFieldOption/10802", value: "Prudential Financial", id: "10802" },
    ];
    expect(extractCustomers(raw)).toEqual(["Prudential Financial"]);
  });

  it("handles multiple selected customers", () => {
    expect(
      extractCustomers([{ value: "BCG" }, { value: "Luminor Group" }]),
    ).toEqual(["BCG", "Luminor Group"]);
  });

  it("falls back to name when value is absent", () => {
    expect(extractCustomers([{ name: "Acme" }])).toEqual(["Acme"]);
  });

  it("trims whitespace and drops empty/blank options", () => {
    expect(
      extractCustomers([{ value: "  Spaced  " }, { value: "" }, { value: "   " }, {}]),
    ).toEqual(["Spaced"]);
  });

  it("returns [] for null / undefined / non-array", () => {
    expect(extractCustomers(null)).toEqual([]);
    expect(extractCustomers(undefined)).toEqual([]);
    // @ts-expect-error guarding against malformed API payloads at runtime
    expect(extractCustomers({ value: "x" })).toEqual([]);
  });

  it("exposes the verified custom field id", () => {
    expect(CUSTOMER_FIELD).toBe("customfield_10044");
  });
});

describe("parseDependencies (issuelinks → roadmap deps)", () => {
  const linked = (key: string, statusKey: string) => ({
    key,
    fields: { summary: `${key} summary`, status: { name: statusKey === "done" ? "Done" : "In Progress", statusCategory: { key: statusKey } } },
  });

  it("maps an inward 'is blocked by' link to an unresolved blocker", () => {
    const links: RawIssueLink[] = [
      { type: { name: "Blocks", inward: "is blocked by", outward: "blocks" }, inwardIssue: linked("EAC-9", "indeterminate") },
    ];
    const [d] = parseDependencies(links, "https://j");
    expect(d).toMatchObject({ key: "EAC-9", direction: "blocked-by", isBlocker: true, url: "https://j/browse/EAC-9" });
  });

  it("does NOT flag a blocker that is already done", () => {
    const links: RawIssueLink[] = [
      { type: { name: "Blocks", inward: "is blocked by", outward: "blocks" }, inwardIssue: linked("EAC-9", "done") },
    ];
    expect(parseDependencies(links, "https://j")[0].isBlocker).toBe(false);
  });

  it("maps an outward 'blocks' link as a non-blocker for the source", () => {
    const links: RawIssueLink[] = [
      { type: { name: "Blocks", inward: "is blocked by", outward: "blocks" }, outwardIssue: linked("EAC-2", "new") },
    ];
    const [d] = parseDependencies(links, "https://j");
    expect(d).toMatchObject({ key: "EAC-2", direction: "blocks", isBlocker: false });
  });

  it("skips links with neither inward nor outward issue", () => {
    expect(parseDependencies([{ type: { name: "Blocks" } }], "https://j")).toEqual([]);
    expect(parseDependencies(undefined, "https://j")).toEqual([]);
  });
});

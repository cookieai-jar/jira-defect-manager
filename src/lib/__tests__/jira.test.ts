import { describe, it, expect } from "vitest";
import { extractCustomers, CUSTOMER_FIELD } from "@/lib/jira";

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

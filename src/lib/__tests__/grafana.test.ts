import { describe, it, expect } from "vitest";
import { parsePromInstant, parsePromMatrix, distinctLabelValues } from "@/lib/grafana";

describe("parsePromInstant", () => {
  it("parses a normal instant response", () => {
    const json = {
      data: {
        result: [
          { metric: { tenant: "acme", integration: "okta" }, value: [1700000000, "42"] },
          { metric: { tenant: "globex", integration: "aws" }, value: [1700000001, "7.5"] },
        ],
      },
    };
    expect(parsePromInstant(json)).toEqual([
      { metric: { tenant: "acme", integration: "okta" }, value: 42, t: 1700000000 },
      { metric: { tenant: "globex", integration: "aws" }, value: 7.5, t: 1700000001 },
    ]);
  });

  it("tolerates missing data/result", () => {
    expect(parsePromInstant({})).toEqual([]);
    expect(parsePromInstant({ data: {} })).toEqual([]);
    expect(parsePromInstant(null)).toEqual([]);
    expect(parsePromInstant({ data: { result: "nope" } })).toEqual([]);
  });

  it("drops samples with NaN / unparseable values and defaults missing metric to {}", () => {
    const json = {
      data: {
        result: [
          { metric: { tenant: "acme" }, value: [1700000000, "NaN"] },
          { value: [1700000001, "9"] }, // missing metric -> {}
          { metric: { tenant: "bad" }, value: [1700000002, "not-a-number"] },
          { metric: { tenant: "short" }, value: [1700000003] }, // malformed tuple
        ],
      },
    };
    expect(parsePromInstant(json)).toEqual([{ metric: {}, value: 9, t: 1700000001 }]);
  });
});

describe("parsePromMatrix", () => {
  it("parses multiple series with ts -> ISO", () => {
    const json = {
      data: {
        result: [
          {
            metric: { tenant: "acme", integration: "okta" },
            values: [
              [1700000000, "1"],
              [1700000600, "2"],
            ],
          },
          {
            metric: { tenant: "globex" },
            values: [[1700000000, "5"]],
          },
        ],
      },
    };
    expect(parsePromMatrix(json)).toEqual([
      {
        metric: { tenant: "acme", integration: "okta" },
        points: [
          { t: "2023-11-14T22:13:20.000Z", value: 1 },
          { t: "2023-11-14T22:23:20.000Z", value: 2 },
        ],
      },
      {
        metric: { tenant: "globex" },
        points: [{ t: "2023-11-14T22:13:20.000Z", value: 5 }],
      },
    ]);
  });

  it("drops NaN points but keeps the series", () => {
    const json = {
      data: {
        result: [
          {
            metric: { tenant: "acme" },
            values: [
              [1700000000, "NaN"],
              [1700000600, "3"],
              [1700001200, "bogus"],
            ],
          },
        ],
      },
    };
    expect(parsePromMatrix(json)).toEqual([
      { metric: { tenant: "acme" }, points: [{ t: "2023-11-14T22:23:20.000Z", value: 3 }] },
    ]);
  });

  it("tolerates missing data/result and empty values", () => {
    expect(parsePromMatrix({})).toEqual([]);
    expect(parsePromMatrix(null)).toEqual([]);
    expect(parsePromMatrix({ data: { result: [{ metric: { a: "b" } }] } })).toEqual([
      { metric: { a: "b" }, points: [] },
    ]);
  });
});

describe("distinctLabelValues", () => {
  it("returns sorted, de-duplicated label values", () => {
    const series = [
      { metric: { tenant: "globex" } },
      { metric: { tenant: "acme" } },
      { metric: { tenant: "globex" } },
      { metric: { tenant: "beta" } },
    ];
    expect(distinctLabelValues(series, "tenant")).toEqual(["acme", "beta", "globex"]);
  });

  it("ignores series missing the label or with empty values", () => {
    const series: Array<{ metric: Record<string, string> }> = [
      { metric: { tenant: "acme" } },
      { metric: { integration: "okta" } },
      { metric: { tenant: "" } },
    ];
    expect(distinctLabelValues(series, "tenant")).toEqual(["acme"]);
  });

  it("returns [] when no series have the label", () => {
    expect(distinctLabelValues([{ metric: {} }], "tenant")).toEqual([]);
  });
});

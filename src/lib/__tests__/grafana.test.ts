import { describe, it, expect } from "vitest";
import { parsePromInstant, parsePromMatrix, distinctLabelValues, parseTenantAlerts } from "@/lib/grafana";

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

describe("parseTenantAlerts", () => {
  const alerts = [
    { labels: { alertname: "ParseFailures", tenant_id: "bcgprod", agent_type: "s3", severity: "warning" }, status: { state: "active" }, startsAt: "2026-06-01T00:00:00Z", generatorURL: "http://g/1" },
    { labels: { alertname: "ExtractionJobsStuckPending_Tier24", namespace: "bcgprod-cp", agent_type: "sharepoint", severity: "critical" }, status: { state: "active" } },
    { labels: { alertname: "AuditLogExtractionFailures", tenant_id: "bcgprod", error_reason: "UNKNOWN", severity: "warning" }, status: { state: "active" } },
    { labels: { alertname: "SomeoneElse", tenant_id: "other", severity: "critical" }, status: { state: "active" } },
  ];

  it("matches by tenant_id OR <tenant>-cp namespace, excludes other tenants", () => {
    const out = parseTenantAlerts(alerts, "bcgprod");
    expect(out.map((a) => a.name).sort()).toEqual([
      "AuditLogExtractionFailures",
      "ExtractionJobsStuckPending_Tier24",
      "ParseFailures",
    ]);
  });

  it("maps severity, kind, reason, integration, state", () => {
    const out = parseTenantAlerts(alerts, "bcgprod");
    const parse = out.find((a) => a.name === "ParseFailures")!;
    expect(parse).toMatchObject({ integration: "s3", kind: "parse", severity: "warning", state: "firing", url: "http://g/1" });
    const stuck = out.find((a) => a.name.includes("Stuck"))!;
    expect(stuck).toMatchObject({ integration: "sharepoint", kind: "extraction", severity: "critical" });
    const audit = out.find((a) => a.name === "AuditLogExtractionFailures")!;
    expect(audit.reason).toBe("UNKNOWN");
  });

  it("maps non-critical/warning severities (info) to ok and suppressed to resolved", () => {
    const out = parseTenantAlerts(
      [{ labels: { alertname: "Info", tenant_id: "bcgprod", severity: "info" }, status: { state: "suppressed" } }],
      "bcgprod",
    );
    expect(out[0].severity).toBe("ok");
    expect(out[0].state).toBe("resolved");
  });

  it("returns [] for non-array / empty", () => {
    expect(parseTenantAlerts(null, "bcgprod")).toEqual([]);
    expect(parseTenantAlerts([], "bcgprod")).toEqual([]);
  });
});

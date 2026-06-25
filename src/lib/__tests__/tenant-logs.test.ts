import { describe, it, expect } from "vitest";
import {
  tenantDpSelector,
  extractionProbeSelector,
  providersForTypeQuery,
  totalProvidersQuery,
  errorByTypeQuery,
} from "@/lib/tenant-logs";

describe("tenantDpSelector", () => {
  it("targets the tenant's data-plane namespace", () => {
    expect(tenantDpSelector("bcgprod")).toBe('{namespace="bcgprod-dp"}');
  });
});

describe("extractionProbeSelector", () => {
  it("matches any extraction line in the data plane", () => {
    expect(extractionProbeSelector("bcgprod")).toBe(
      '{namespace="bcgprod-dp"} |= `Extracting data source`',
    );
  });
});

describe("providersForTypeQuery", () => {
  it("counts distinct providers for one integration type (default 1h window)", () => {
    expect(providersForTypeQuery("bcgprod", "sharepoint")).toBe(
      'count(count by (provider_id) (count_over_time({namespace="bcgprod-dp"} |= `FINISH - Extracting data source` | json | datasource_type=`sharepoint` [1h])))',
    );
  });
  it("honors a window override", () => {
    expect(providersForTypeQuery("acme", "okta", 2)).toContain("[2h]");
  });
});

describe("totalProvidersQuery", () => {
  it("counts distinct providers tenant-wide (default 1h window)", () => {
    expect(totalProvidersQuery("bcgprod")).toBe(
      'count(count by (provider_id) (count_over_time({namespace="bcgprod-dp"} |= `FINISH - Extracting data source` | json [1h])))',
    );
  });
});

describe("errorByTypeQuery", () => {
  it("counts extraction-error lines per datasource_type", () => {
    expect(errorByTypeQuery("bcgprod", 24)).toBe(
      'sum by (datasource_type) (count_over_time({namespace="bcgprod-dp"} |= `Error extracting data sources` | json [24h]))',
    );
  });
});

import { normalizeErrorSignature, topErrorsByType, errorTimelineQuery, errorSamplesQuery, recentStartByTypeQuery } from "@/lib/tenant-logs";

describe("normalizeErrorSignature", () => {
  it("strips the [type - uuid] prefix and ids so the same failure collapses", () => {
    const a = normalizeErrorSignature("extract [azure_sql - 019d3047-9b3e-7ece-8418-8b6ffd9dafc1]: connect error: cannot reach host");
    const b = normalizeErrorSignature("extract [azure_sql - 019d3047-aaaa-7027-81ff-d5b3c843b983]: connect error: cannot reach host");
    expect(a).toBe(b); // ids removed -> identical signature
    expect(a).toContain("connect error: cannot reach host");
    expect(a).not.toContain("019d3047");
  });
  it("collapses long numeric ids and whitespace", () => {
    expect(normalizeErrorSignature("rate limited after 1234567 attempts")).toBe("rate limited after <n> attempts");
  });
});

describe("topErrorsByType", () => {
  it("groups by datasource_type and ranks normalized signatures", () => {
    const lines = [
      JSON.stringify({ datasource_type: "azure_sql", error: "extract [azure_sql - 019d3047-9b3e-7ece-8418-8b6ffd9dafc1]: connect error: cannot reach host" }),
      JSON.stringify({ datasource_type: "azure_sql", error: "extract [azure_sql - 019d3047-bbbb-7027-81ff-d5b3c843b983]: connect error: cannot reach host" }),
      JSON.stringify({ datasource_type: "azure_sql", error: "extract [azure_sql - 019d3047-cccc-7027-81ff-d5b3c843b983]: permission denied" }),
      JSON.stringify({ datasource_type: "s3", error: "throttled" }),
      "not json",
      JSON.stringify({ datasource_type: "s3" }), // no error -> skipped
    ];
    const m = topErrorsByType(lines, 2);
    const azure = m.get("azure_sql")!;
    expect(azure[0]).toEqual({ signature: "connect error: cannot reach host", count: 2 });
    expect(azure[1].count).toBe(1);
    expect(m.get("s3")).toEqual([{ signature: "throttled", count: 1 }]);
  });
  it("returns empty map for no parseable lines", () => {
    expect(topErrorsByType(["x", "{}"]).size).toBe(0);
  });
});

describe("error query builders", () => {
  it("errorTimelineQuery counts the error line per bucket", () => {
    expect(errorTimelineQuery("bcgprod", "1h")).toBe(
      'sum(count_over_time({namespace="bcgprod-dp"} |= `Error extracting data sources` [1h]))',
    );
  });
  it("errorSamplesQuery selects parsed error lines", () => {
    expect(errorSamplesQuery("bcgprod")).toBe(
      '{namespace="bcgprod-dp"} |= `Error extracting data sources` | json',
    );
  });
  it("recentStartByTypeQuery counts recent START lines per datasource_type", () => {
    expect(recentStartByTypeQuery("bcgprod", "10m")).toBe(
      'sum by (datasource_type) (count_over_time({namespace="bcgprod-dp"} |= `START - Extracting data source` | json [10m]))',
    );
  });
});

describe("normalizeErrorSignature — double extract prefix", () => {
  it("strips a repeated 'extract:' prefix (real cp log shape)", () => {
    // real line: "extract [type - id]: extract: connect error: ..."
    const sig = normalizeErrorSignature("extract [azure_sql - 019d3047-9b3e-7ece-8418-8b6ffd9dafc1]: extract: connect error: cannot reach host");
    expect(sig).toBe("connect error: cannot reach host");
  });
});

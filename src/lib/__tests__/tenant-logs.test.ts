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

import { parseFeatureFlagLines, parseDataPlaneInfo, regionFromDatasourceName, featureFlagsQuery, dataPlaneInfoQuery } from "@/lib/tenant-logs";

describe("regionFromDatasourceName", () => {
  it("extracts the region from a regional Loki datasource name", () => {
    expect(regionFromDatasourceName("grafanacloud-vezalondon-logs-eu-west-2")).toBe("eu-west-2");
    expect(regionFromDatasourceName("grafanacloud-vezacanada-logs-ca-central-1")).toBe("ca-central-1");
  });
  it("returns null when there is no region segment", () => {
    expect(regionFromDatasourceName("grafanacloud-logs")).toBeNull();
    expect(regionFromDatasourceName(undefined)).toBeNull();
  });
  it("does not match a region token embedded mid-word", () => {
    expect(regionFromDatasourceName("grafanacloud-census-east-1-logs")).toBeNull(); // not "us-east-1"
  });
});

describe("parseFeatureFlagLines", () => {
  it("takes current from the newest line and keeps the change history", () => {
    // lines are newest-first (Loki backward)
    const lines = [
      JSON.stringify({ ts: 1782349792, flags: "NRR_A,NRR_B" }),
      JSON.stringify({ ts: 1782300000, flags: "NRR_A" }),
    ];
    const ff = parseFeatureFlagLines(lines);
    expect(ff.current).toEqual(["NRR_A", "NRR_B"]);
    expect(ff.changes).toHaveLength(2);
    expect(ff.changes[0].t).toBe(new Date(1782349792 * 1000).toISOString()); // newest first
    expect(ff.changes[1].flags).toEqual(["NRR_A"]);
  });
  it("handles single flag, whitespace lists, and skips junk / missing ts", () => {
    expect(parseFeatureFlagLines([JSON.stringify({ ts: 1, flags: "NRR_X" })]).current).toEqual(["NRR_X"]);
    expect(parseFeatureFlagLines([JSON.stringify({ ts: 1, flags: "NRR_X NRR_Y" })]).current).toEqual(["NRR_X", "NRR_Y"]);
    expect(parseFeatureFlagLines(["bad", JSON.stringify({ flags: "NRR_X" })]).changes).toEqual([]); // no ts -> skipped
  });
  it("returns empty for no lines", () => {
    expect(parseFeatureFlagLines([])).toEqual({ current: [], changes: [] });
  });
  it("sorts un-ordered multi-stream input by ts and collapses duplicate emissions", () => {
    // out-of-order (as flattened per-pod streams arrive), with repeated identical sets
    const lines = [
      JSON.stringify({ ts: 1000, flags: "NRR_A" }),
      JSON.stringify({ ts: 3000, flags: "NRR_A,NRR_B" }), // newest
      JSON.stringify({ ts: 2999, flags: "NRR_A,NRR_B" }), // dup of newest set
      JSON.stringify({ ts: 2000, flags: "NRR_A" }),
    ];
    const ff = parseFeatureFlagLines(lines);
    expect(ff.current).toEqual(["NRR_A", "NRR_B"]); // truly newest despite input order
    // collapses the two identical [A,B] emissions; transitions: [A,B] then [A]
    expect(ff.changes.map((c) => c.flags)).toEqual([["NRR_A", "NRR_B"], ["NRR_A"]]);
  });
  it("keeps non-adjacent equal sets as distinct transitions (A -> B -> A)", () => {
    const lines = [
      JSON.stringify({ ts: 3, flags: "NRR_A" }),
      JSON.stringify({ ts: 2, flags: "NRR_B" }),
      JSON.stringify({ ts: 1, flags: "NRR_A" }),
    ];
    const ff = parseFeatureFlagLines(lines);
    expect(ff.current).toEqual(["NRR_A"]);
    expect(ff.changes.map((c) => c.flags)).toEqual([["NRR_A"], ["NRR_B"], ["NRR_A"]]);
  });
});

describe("parseDataPlaneInfo", () => {
  it("reads version + edp_id from the newest parseable line", () => {
    const lines = [JSON.stringify({ current_version: "2026.6.22", edp_id: "019d44e2" }), "junk"];
    expect(parseDataPlaneInfo(lines)).toEqual({ insightPointVersion: "2026.6.22", edpId: "019d44e2" });
  });
  it("nulls missing fields and empty input", () => {
    expect(parseDataPlaneInfo([JSON.stringify({})])).toEqual({ insightPointVersion: null, edpId: null });
    expect(parseDataPlaneInfo([])).toEqual({ insightPointVersion: null, edpId: null });
  });
  it("returns the NEWEST version by ts, not array order (rolling upgrade)", () => {
    // un-ordered input (old pod listed first); must pick the newer version
    const lines = [
      JSON.stringify({ ts: 100, current_version: "2026.6.20", edp_id: "e1" }),
      JSON.stringify({ ts: 200, current_version: "2026.6.22", edp_id: "e1" }),
    ];
    expect(parseDataPlaneInfo(lines)).toEqual({ insightPointVersion: "2026.6.22", edpId: "e1" });
  });
});

describe("feature-flag / data-plane query builders", () => {
  it("featureFlagsQuery selects the dynamic-flags-updated line", () => {
    expect(featureFlagsQuery("bcgprod")).toBe(
      '{namespace="bcgprod-dp"} |= `Dynamic feature flags updated` | json',
    );
  });
  it("dataPlaneInfoQuery selects the data-plane info line (control-plane namespace)", () => {
    expect(dataPlaneInfoQuery("bcgprod")).toBe('{namespace="bcgprod-cp"} |= `Data plane info` | json');
  });
});

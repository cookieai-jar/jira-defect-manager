import { describe, it, expect } from "vitest";
import {
  tenantDpSelector,
  extractionProbeSelector,
  finishByTypeQuery,
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

describe("finishByTypeQuery", () => {
  it("counts FINISH lines per datasource_type over the window", () => {
    expect(finishByTypeQuery("bcgprod", 24)).toBe(
      'sum by (datasource_type) (count_over_time({namespace="bcgprod-dp"} |= `FINISH - Extracting data source` | json [24h]))',
    );
  });
  it("defaults to a 24h window and honors overrides", () => {
    expect(finishByTypeQuery("acme")).toContain("[24h]");
    expect(finishByTypeQuery("acme", 6)).toContain("[6h]");
    expect(finishByTypeQuery("acme", 6)).toContain('{namespace="acme-dp"}');
  });
});

describe("errorByTypeQuery", () => {
  it("counts extraction-error lines per datasource_type", () => {
    expect(errorByTypeQuery("bcgprod", 24)).toBe(
      'sum by (datasource_type) (count_over_time({namespace="bcgprod-dp"} |= `Error extracting data sources` | json [24h]))',
    );
  });
});

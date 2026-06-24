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

import { describe, it, expect } from "vitest";
import { connectorDetailUrl, tenantHealthDashboardUrl, lokiErrorLogsUrl } from "@/lib/tenant-grafana-links";

describe("connectorDetailUrl", () => {
  it("builds an integrations-health link scoped to tenant + agent_type", () => {
    const url = connectorDetailUrl("https://g.example.net", "bcgprod", "sharepoint");
    expect(url).toContain("https://g.example.net/d/integrations-health?");
    expect(url).toContain("var-tenant_id=bcgprod");
    expect(url).toContain("var-agent_type=sharepoint");
    expect(url).not.toContain("var-namespace"); // this dashboard has no namespace var
  });
  it("trims a trailing slash on the base", () => {
    expect(connectorDetailUrl("https://g/", "t", "okta")).toContain("https://g/d/integrations-health");
  });
  it("returns null without a base URL", () => {
    expect(connectorDetailUrl(null, "t", "okta")).toBeNull();
    expect(connectorDetailUrl(undefined, "t", "okta")).toBeNull();
    expect(connectorDetailUrl("", "t", "okta")).toBeNull();
  });
  it("url-encodes special characters in values", () => {
    const url = connectorDetailUrl("https://g", "t", "a b")!;
    expect(url).toContain("var-agent_type=a+b");
  });
});

describe("tenantHealthDashboardUrl", () => {
  it("links to the integration & LCM health dashboard", () => {
    expect(tenantHealthDashboardUrl("https://g")).toBe("https://g/d/jd6cs94");
  });
  it("returns null without a base", () => {
    expect(tenantHealthDashboardUrl(null)).toBeNull();
  });
});

describe("lokiErrorLogsUrl", () => {
  it("builds a Grafana Explore link into the tenant's regional Loki error stream", () => {
    const url = lokiErrorLogsUrl("https://g.example.net", "loki-uid-1", "bcgprod", null, 24)!;
    expect(url.startsWith("https://g.example.net/explore?")).toBe(true);
    expect(url).toContain("schemaVersion=1");
    expect(url).toContain("orgId=1");
    // decode the panes JSON to assert the query without depending on encoding
    const panes = JSON.parse(new URL(url).searchParams.get("panes")!);
    const pane = panes.err;
    expect(pane.datasource).toBe("loki-uid-1");
    expect(pane.queries[0].datasource).toEqual({ type: "loki", uid: "loki-uid-1" });
    expect(pane.queries[0].expr).toBe(
      '{namespace="bcgprod-dp"} |= `Error extracting data sources` | json',
    );
    expect(pane.range).toEqual({ from: "now-24h", to: "now" });
  });
  it("scopes to one integration via a datasource_type filter when given", () => {
    const url = lokiErrorLogsUrl("https://g", "uid", "acme", "sharepoint", 6)!;
    const expr = JSON.parse(new URL(url).searchParams.get("panes")!).err.queries[0].expr;
    expect(expr).toBe(
      '{namespace="acme-dp"} |= `Error extracting data sources` | json | datasource_type=`sharepoint`',
    );
    expect(JSON.parse(new URL(url).searchParams.get("panes")!).err.range.from).toBe("now-6h");
  });
  it("returns null without a base or datasource uid", () => {
    expect(lokiErrorLogsUrl(null, "uid", "t")).toBeNull();
    expect(lokiErrorLogsUrl("https://g", null, "t")).toBeNull();
    expect(lokiErrorLogsUrl("https://g", "", "t")).toBeNull();
  });
});

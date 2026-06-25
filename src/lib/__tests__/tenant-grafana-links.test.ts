import { describe, it, expect } from "vitest";
import { connectorDetailUrl, tenantHealthDashboardUrl } from "@/lib/tenant-grafana-links";

describe("connectorDetailUrl", () => {
  it("builds a connector-detail link scoped to tenant + agent_type + namespace", () => {
    const url = connectorDetailUrl("https://g.example.net", "bcgprod", "sharepoint");
    expect(url).toContain("https://g.example.net/d/connector-detail?");
    expect(url).toContain("var-tenant_id=bcgprod");
    expect(url).toContain("var-agent_type=sharepoint");
    expect(url).toContain("var-namespace=bcgprod-dp");
  });
  it("trims a trailing slash on the base", () => {
    expect(connectorDetailUrl("https://g/", "t", "okta")).toContain("https://g/d/connector-detail");
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

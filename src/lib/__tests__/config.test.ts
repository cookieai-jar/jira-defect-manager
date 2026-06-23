import { describe, it, expect } from "vitest";
import { defaults, mergeConfig, parseConfig } from "@/lib/config-core";

describe("parseConfig", () => {
  it("returns defaults for null/empty/garbage", () => {
    expect(parseConfig(null)).toEqual(defaults());
    expect(parseConfig("")).toEqual(defaults());
    expect(parseConfig("{not json")).toEqual(defaults());
  });

  it("includes the Strategic Integrations defaults", () => {
    const c = defaults();
    expect(typeof c.siJql).toBe("string");
    expect(c.siJql.length).toBeGreaterThan(0);
    expect(c.siDashboard).toBe(true);
  });

  it("migrates the legacy masterJql into jqls.eac", () => {
    const c = parseConfig(JSON.stringify({ masterJql: "project = OLD ORDER BY updated DESC" }));
    expect(c.jqls.eac).toBe("project = OLD ORDER BY updated DESC");
  });

  it("preserves stored siJql/siDashboard and fills missing scope jqls", () => {
    const c = parseConfig(
      JSON.stringify({ siJql: "project = INT", siDashboard: false, jqls: { eac: "X" } }),
    );
    expect(c.siJql).toBe("project = INT");
    expect(c.siDashboard).toBe(false);
    expect(c.jqls.eac).toBe("X");
    expect(c.jqls.fr).toBe(defaults().jqls.fr); // backfilled
  });

  it("defaults siDashboard to true when only siJql is stored", () => {
    const c = parseConfig(JSON.stringify({ siJql: "project = INT" }));
    expect(c.siDashboard).toBe(true);
  });

  it("defaults tenantDashboard to true and preserves a stored false", () => {
    expect(defaults().tenantDashboard).toBe(true);
    expect(parseConfig(JSON.stringify({})).tenantDashboard).toBe(true);
    expect(parseConfig(JSON.stringify({ tenantDashboard: false })).tenantDashboard).toBe(false);
  });
});

describe("mergeConfig", () => {
  it("deep-merges nested jqls/dashboards and overrides top-level scalars", () => {
    const base = defaults();
    const next = mergeConfig(base, {
      jqls: { sec: "SEC JQL" },
      dashboards: { fr: false },
      siJql: "project = NEW",
      siDashboard: false,
      maxIssuesPerSync: 123,
    });
    // overridden
    expect(next.jqls.sec).toBe("SEC JQL");
    expect(next.dashboards.fr).toBe(false);
    expect(next.siJql).toBe("project = NEW");
    expect(next.siDashboard).toBe(false);
    expect(next.maxIssuesPerSync).toBe(123);
    // preserved
    expect(next.jqls.eac).toBe(base.jqls.eac);
    expect(next.dashboards.eac).toBe(true);
    expect(next.sprintLengthDays).toBe(base.sprintLengthDays);
  });

  it("does not mutate the base config", () => {
    const base = defaults();
    mergeConfig(base, { siDashboard: false, jqls: { eac: "Z" } });
    expect(base.siDashboard).toBe(true);
    expect(base.jqls.eac).toBe(defaults().jqls.eac);
  });
});

import { describe, it, expect } from "vitest";
import {
  normalizeTenantDisplayName,
  jiraCustomerJql,
  worstOf,
  classifyErrors,
  computeHealthScore,
  buildTopIssues,
  buildIntegrationHealth,
} from "@/lib/tenant-health";
import type { Severity, TenantAlert } from "@/types/tenant";

function alert(over: Partial<TenantAlert> = {}): TenantAlert {
  return {
    integration: null,
    kind: "other",
    name: "Alert",
    state: "firing",
    severity: "warning",
    reason: null,
    firedAt: null,
    source: "grafana",
    url: null,
    ...over,
  };
}

describe("normalizeTenantDisplayName", () => {
  it("uses the override map", () => {
    expect(normalizeTenantDisplayName("bcgprod")).toBe("BCG");
  });
  it("falls back to stripping env suffix + title-casing", () => {
    expect(normalizeTenantDisplayName("acme-corp-prod")).toBe("Acme Corp");
    expect(normalizeTenantDisplayName("wajax")).toBe("Wajax");
    expect(normalizeTenantDisplayName("customersbank-prod")).toBe("Customersbank");
  });
});

describe("jiraCustomerJql", () => {
  it("targets customfield_10044 and escapes quotes", () => {
    expect(jiraCustomerJql("BCG")).toBe('cf[10044] = "BCG" ORDER BY updated DESC');
    expect(jiraCustomerJql('A"B')).toBe('cf[10044] = "A\\"B" ORDER BY updated DESC');
  });
});

describe("worstOf", () => {
  it("ranks critical > warning > ok", () => {
    expect(worstOf(["ok", "warning", "critical"])).toBe("critical");
    expect(worstOf(["ok", "warning"])).toBe("warning");
    expect(worstOf(["ok"])).toBe("ok");
    expect(worstOf([])).toBe("ok");
  });
});

describe("classifyErrors", () => {
  it("counts unknown (UNKNOWN/INTERNAL reason or *Unknown*/*Internal* name) vs known", () => {
    const c = classifyErrors([
      alert({ name: "AuditLogExtractionFailures", reason: "UNKNOWN" }),
      alert({ name: "PostgreSQLUnknownClassExtractionFailure", reason: null }),
      alert({ name: "ParseFailures", reason: "EXTRACTION_PERMISSION_DENIED" }),
      alert({ name: "Generic", reason: null }), // no signal -> skipped
    ]);
    expect(c).toEqual({ known: 1, unknown: 2 });
  });
});

describe("computeHealthScore", () => {
  it("deducts for firing alerts and error'd integrations, clamped", () => {
    const integrations = [
      { integration: "s3", extractions: 1, extractionErrors: 2, parseAvgMs: null, parseTasks: 0, alerts: [], breaches: [], severity: "warning" as Severity },
      { integration: "okta", extractions: 1, extractionErrors: 0, parseAvgMs: null, parseTasks: 0, alerts: [], breaches: [], severity: "ok" as Severity },
    ];
    // 100 - 15(crit) - 6(warn) - 8(one int with errors) = 71
    expect(
      computeHealthScore(integrations, [alert({ severity: "critical" }), alert({ severity: "warning" })]),
    ).toBe(71);
  });
  it("ignores resolved alerts and clamps to 0", () => {
    const many = Array.from({ length: 10 }, () => alert({ severity: "critical" }));
    expect(computeHealthScore([], many)).toBe(0);
    expect(computeHealthScore([], [alert({ severity: "critical", state: "resolved" })])).toBe(100);
  });
});

describe("buildTopIssues", () => {
  it("orders critical-first, dedupes, and caps", () => {
    const issues = buildTopIssues(
      [{ integration: "ad", extractions: 0, extractionErrors: 5, parseAvgMs: null, parseTasks: 0, alerts: [], breaches: [], severity: "warning" }],
      [
        alert({ severity: "warning", name: "ParseFailures", integration: "s3" }),
        alert({ severity: "critical", name: "ExtractionStuck", integration: "sharepoint", reason: "Tier24" }),
        alert({ severity: "ok", name: "Info" }), // excluded (ok)
      ],
      6,
    );
    expect(issues[0]).toBe("sharepoint: ExtractionStuck (Tier24)"); // critical first
    expect(issues).toContain("s3: ParseFailures");
    expect(issues).toContain("ad: 5 extraction errors");
    expect(issues.some((i) => i.includes("Info"))).toBe(false);
  });
});

describe("buildIntegrationHealth", () => {
  it("builds inventory from extraction + non-CSC parse, excludes CSC pairs, computes parseAvg + severity, sorts", () => {
    const rows = buildIntegrationHealth({
      extractions: new Map([["okta", 100], ["s3", 50]]),
      extractionErrors: new Map([["s3", 3]]),
      parseDurationMs: new Map([["okta", 2000], ["ad_base", 400], ["awsiam-okta", 9999]]),
      parseTasks: new Map([["okta", 10], ["ad_base", 4], ["awsiam-okta", 5]]),
      alertsByIntegration: new Map([["s3", [alert({ severity: "warning", integration: "s3" })]]]),
    });
    const names = rows.map((r) => r.integration);
    expect(names).toContain("okta");
    expect(names).toContain("s3");
    expect(names).toContain("ad_base"); // non-CSC parse base included
    expect(names).not.toContain("awsiam-okta"); // CSC pair excluded

    const okta = rows.find((r) => r.integration === "okta")!;
    expect(okta.parseAvgMs).toBe(200); // 2000ms / 10 tasks
    expect(okta.severity).toBe("ok");

    const s3 = rows.find((r) => r.integration === "s3")!;
    // alert warning + error_count>0 breach (default threshold) => warning
    expect(s3.severity).toBe("warning");
    expect(s3.extractionErrors).toBe(3);

    // warning (s3) sorts before ok (okta)
    expect(rows.findIndex((r) => r.integration === "s3")).toBeLessThan(
      rows.findIndex((r) => r.integration === "okta"),
    );
  });

  it("parseAvgMs is null when no parse tasks", () => {
    const rows = buildIntegrationHealth({
      extractions: new Map([["okta", 5]]),
      extractionErrors: new Map(),
      parseDurationMs: new Map(),
      parseTasks: new Map(),
      alertsByIntegration: new Map(),
    });
    expect(rows[0].parseAvgMs).toBeNull();
  });
});

import { buildFleetSummaries, scoreFromSignals } from "@/lib/tenant-health";

describe("scoreFromSignals", () => {
  it("deducts 15/critical, 6/warning, 8/errored-integration, clamped", () => {
    expect(scoreFromSignals(0, 0, 0)).toBe(100);
    expect(scoreFromSignals(1, 1, 1)).toBe(71);
    expect(scoreFromSignals(10, 0, 0)).toBe(0); // clamp
  });
});

describe("buildFleetSummaries", () => {
  const inputs = {
    extractionRows: [
      { tenant: "bcgprod", agent: "okta", value: 100.7 },
      { tenant: "bcgprod", agent: "s3", value: 50 },
      { tenant: "healthyco", agent: "aws", value: 10 },
    ],
    errorsByTenant: new Map([["bcgprod", 0]]),
    alertsByTenant: new Map<string, TenantAlert[]>([
      [
        "bcgprod",
        [
          alert({ severity: "warning", name: "ParseFailures", integration: "s3", state: "firing" }),
          alert({ severity: "ok", name: "Info", state: "firing" }),
          alert({ severity: "critical", name: "Resolved", state: "resolved" }), // ignored (resolved)
        ],
      ],
      ["alertonly", [alert({ severity: "critical", name: "Stuck", integration: "sharepoint" })]],
    ]),
  };

  it("aggregates extractions + distinct integrations per tenant (rounded)", () => {
    const rows = buildFleetSummaries(inputs);
    const bcg = rows.find((r) => r.tenant === "bcgprod")!;
    expect(bcg.extractions).toBe(151); // 100.7 + 50 rounded
    expect(bcg.integrations).toBe(2); // okta, s3
    expect(bcg.displayName).toBe("BCG");
  });

  it("counts only firing alerts by severity and picks worst for top issue", () => {
    const rows = buildFleetSummaries(inputs);
    const bcg = rows.find((r) => r.tenant === "bcgprod")!;
    expect(bcg.warningAlerts).toBe(1);
    expect(bcg.criticalAlerts).toBe(0);
    expect(bcg.activeAlerts).toBe(2); // warning + ok firing; resolved excluded
    expect(bcg.topIssue).toBe("s3: ParseFailures");
  });

  it("includes alert-only tenants (no metrics) and sorts worst-health first", () => {
    const rows = buildFleetSummaries(inputs);
    expect(rows.map((r) => r.tenant)).toContain("alertonly");
    // alertonly has a critical alert -> lowest score -> first
    expect(rows[0].tenant).toBe("alertonly");
    expect(rows[0].severity).toBe("critical");
  });

  it("healthyco with no alerts/errors scores 100", () => {
    const rows = buildFleetSummaries(inputs);
    const h = rows.find((r) => r.tenant === "healthyco")!;
    expect(h.healthScore).toBe(100);
    expect(h.topIssue).toBeNull();
  });
});

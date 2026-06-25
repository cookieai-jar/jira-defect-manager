import { describe, it, expect } from "vitest";
import {
  jiraCustomerJql,
  worstOf,
  classifyErrors,
  computeHealthScore,
  buildTopIssues,
  buildIntegrationHealth,
  integrationState,
} from "@/lib/tenant-health";
import { makeNameResolver } from "@/lib/tenant-mapping";
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
      { integration: "s3", providers: 1, extractionErrors: 2, parseAvgMs: null, parseTasks: 0, state: "failing" as const, extractingNow: false, parsingNow: false, outdated: 0, failing: 0, freshnessSec: null, lagSec: null, topReasons: [], topErrors: [], connectorUrl: null, alerts: [], breaches: [], severity: "warning" as Severity },
      { integration: "okta", providers: 1, extractionErrors: 0, parseAvgMs: null, parseTasks: 0, state: "ok" as const, extractingNow: false, parsingNow: false, outdated: 0, failing: 0, freshnessSec: null, lagSec: null, topReasons: [], topErrors: [], connectorUrl: null, alerts: [], breaches: [], severity: "ok" as Severity },
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
      [{ integration: "ad", providers: 0, extractionErrors: 5, parseAvgMs: null, parseTasks: 0, state: "failing", extractingNow: false, parsingNow: false, outdated: 0, failing: 0, freshnessSec: null, lagSec: null, topReasons: [], topErrors: [], connectorUrl: null, alerts: [], breaches: [], severity: "warning" }],
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

describe("integrationState", () => {
  const base = { extractionErrors: 0, outdated: 0, providers: 5, parseTasks: 10, alerts: [] as TenantAlert[] };
  it("failing when there are extraction errors", () => {
    expect(integrationState({ ...base, extractionErrors: 3 })).toBe("failing");
  });
  it("failing on a critical firing alert (even with no errors)", () => {
    expect(integrationState({ ...base, alerts: [alert({ severity: "critical" })] })).toBe("failing");
  });
  it("stalled when datasources are outdated (and not failing)", () => {
    expect(integrationState({ ...base, outdated: 12 })).toBe("stalled");
  });
  it("stalled on a stuck/pending alert", () => {
    expect(
      integrationState({ ...base, alerts: [alert({ severity: "warning", name: "ExtractionJobsStuckPending_Tier24" })] }),
    ).toBe("stalled");
  });
  it("idle only when providers is exactly 0 (data present), no parse tasks, no alerts", () => {
    expect(integrationState({ extractionErrors: 0, outdated: 0, providers: 0, parseTasks: 0, alerts: [] })).toBe("idle");
  });
  it("is NOT idle when providers is null (regional logs unavailable) — falls back to ok", () => {
    // null = unknown (Loki down); a possibly-extracting integration must not be badged idle.
    expect(integrationState({ extractionErrors: 0, outdated: 0, providers: null, parseTasks: 0, alerts: [] })).toBe("ok");
  });
  it("ok when extracting cleanly", () => {
    expect(integrationState(base)).toBe("ok");
  });
  it("failing takes precedence over stalled", () => {
    expect(integrationState({ ...base, extractionErrors: 1, outdated: 99 })).toBe("failing");
  });
});

describe("buildIntegrationHealth", () => {
  it("unions inventory + provider keys + non-CSC parse, excludes CSC pairs, computes providers/parse/severity, sorts", () => {
    const rows = buildIntegrationHealth({
      inventory: ["okta", "s3"],
      providers: new Map([["okta", 12], ["s3", 4]]),
      hasProviderData: true,
      extractionErrors: new Map([["s3", 3]]),
      parseDurationMs: new Map([["okta", 2000], ["ad_base", 400], ["awsiam-okta", 9999]]),
      parseTasks: new Map([["okta", 10], ["ad_base", 4], ["awsiam-okta", 5]]),
      alertsByIntegration: new Map([["s3", [alert({ severity: "warning", integration: "s3" })]]]),
      outdatedByType: new Map([["s3", 7]]),
      topErrorsByType: new Map([["s3", [{ signature: "connect error", count: 14 }]]]),
      extractingNowTypes: new Set(["okta"]),
      parsingNowTypes: new Set(["s3"]),
      failingByType: new Map([["s3", 5]]),
      topReasonsByType: new Map([["s3", [{ reason: "EXTRACTION_PERMISSION_DENIED", errorClass: "user" as const, count: 5 }]]]),
      freshnessByType: new Map([["okta", 3600]]),
      lagByType: new Map([["s3", 7200]]),
      connectorUrl: (i) => `https://g/d/connector-detail?var-agent_type=${i}`,
    });
    const names = rows.map((r) => r.integration);
    expect(names).toContain("okta");
    expect(names).toContain("s3");
    expect(names).toContain("ad_base"); // non-CSC parse base included
    expect(names).not.toContain("awsiam-okta"); // CSC pair excluded

    const okta = rows.find((r) => r.integration === "okta")!;
    expect(okta.providers).toBe(12);
    expect(okta.parseAvgMs).toBe(200); // 2000ms / 10 tasks
    expect(okta.severity).toBe("ok");
    expect(okta.state).toBe("ok");
    expect(okta.extractingNow).toBe(true); // in extractingNowTypes
    expect(okta.parsingNow).toBe(false);
    expect(okta.connectorUrl).toBe("https://g/d/connector-detail?var-agent_type=okta");

    expect(okta.freshnessSec).toBe(3600); // last parse success 1h ago
    const s3 = rows.find((r) => r.integration === "s3")!;
    expect(s3.outdated).toBe(7); // extraction lag
    expect(s3.failing).toBe(5); // currently-failing datasources (gauge)
    expect(s3.lagSec).toBe(7200);
    expect(s3.topReasons).toEqual([{ reason: "EXTRACTION_PERMISSION_DENIED", errorClass: "user", count: 5 }]);
    expect(s3.topErrors).toEqual([{ signature: "connect error", count: 14 }]);
    // alert warning + error_count>0 breach (default threshold) => warning
    expect(s3.severity).toBe("warning");
    expect(s3.extractionErrors).toBe(3);
    expect(s3.state).toBe("failing"); // has extraction errors
    expect(s3.parsingNow).toBe(true); // in parsingNowTypes

    // warning (s3) sorts before ok (okta)
    expect(rows.findIndex((r) => r.integration === "s3")).toBeLessThan(
      rows.findIndex((r) => r.integration === "okta"),
    );
  });

  it("providers is null when provider data is unavailable (no logs)", () => {
    const rows = buildIntegrationHealth({
      inventory: ["okta"],
      providers: new Map(),
      hasProviderData: false,
      extractionErrors: new Map(),
      parseDurationMs: new Map(),
      parseTasks: new Map(),
      outdatedByType: new Map(),
      topErrorsByType: new Map(),
      extractingNowTypes: new Set(),
      parsingNowTypes: new Set(),
      failingByType: new Map(),
      topReasonsByType: new Map(),
      freshnessByType: new Map(),
      lagByType: new Map(),
      connectorUrl: () => null,
      alertsByIntegration: new Map(),
    });
    expect(rows[0].providers).toBeNull();
    expect(rows[0].parseAvgMs).toBeNull();
    expect(rows[0].failing).toBe(0);
    expect(rows[0].freshnessSec).toBeNull();
  });
});

import { aggregateErrorReasons } from "@/lib/tenant-health";

describe("aggregateErrorReasons", () => {
  const rows = [
    { metric: { agent_type: "awslambda", class: "user", error_reason: "EXTRACTION_PERMISSION_DENIED" }, value: 386 },
    { metric: { agent_type: "awslambda", class: "user", error_reason: "AUTH_AWS_IAM_NOT_ENABLED" }, value: 12 },
    { metric: { agent_type: "okta", class: "internal", error_reason: "INTERNAL" }, value: 4 },
    { metric: { agent_type: "s3", class: "", error_reason: "" }, value: 3 }, // unknown class + reason
    { metric: { agent_type: "ec2", class: "user", error_reason: "X" }, value: 0 }, // dropped (0)
  ];
  it("splits internal vs user and tallies failing per integration", () => {
    const a = aggregateErrorReasons(rows);
    expect(a.errorClass).toEqual({ internal: 4, user: 398 });
    expect(a.failingByType.get("awslambda")).toBe(398);
    expect(a.failingByType.get("ec2")).toBeUndefined(); // 0 dropped
  });
  it("counts a tenant-level row (no agent_type) toward errorClass but not failingByType", () => {
    const a = aggregateErrorReasons([
      { metric: { class: "internal", error_reason: "INTERNAL" }, value: 9 }, // no agent_type
    ]);
    expect(a.errorClass.internal).toBe(9);
    expect(a.failingByType.size).toBe(0);
    expect(a.byIntegration.size).toBe(0);
  });
  it("returns top reasons per integration, most frequent first, with class", () => {
    const a = aggregateErrorReasons(rows, 3);
    expect(a.byIntegration.get("awslambda")).toEqual([
      { reason: "EXTRACTION_PERMISSION_DENIED", errorClass: "user", count: 386 },
      { reason: "AUTH_AWS_IAM_NOT_ENABLED", errorClass: "user", count: 12 },
    ]);
    expect(a.byIntegration.get("s3")![0]).toEqual({ reason: "UNKNOWN", errorClass: "unknown", count: 3 });
  });
  it("builds a tenant-wide top-reasons list with integration", () => {
    const a = aggregateErrorReasons(rows, 3, 2);
    expect(a.topErrorReasons).toHaveLength(2);
    expect(a.topErrorReasons[0]).toEqual({
      reason: "EXTRACTION_PERMISSION_DENIED",
      errorClass: "user",
      count: 386,
      integration: "awslambda",
    });
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
    const rows = buildFleetSummaries(inputs, makeNameResolver(["BCG"]));
    const bcg = rows.find((r) => r.tenant === "bcgprod")!;
    expect(bcg.extractions).toBe(151); // 100.7 + 50 rounded
    expect(bcg.integrations).toBe(2); // okta, s3
    expect(bcg.displayName).toBe("BCG");
  });

  it("counts only firing alerts by severity and picks worst for top issue", () => {
    const rows = buildFleetSummaries(inputs, makeNameResolver(["BCG"]));
    const bcg = rows.find((r) => r.tenant === "bcgprod")!;
    expect(bcg.warningAlerts).toBe(1);
    expect(bcg.criticalAlerts).toBe(0);
    expect(bcg.activeAlerts).toBe(2); // warning + ok firing; resolved excluded
    expect(bcg.topIssue).toBe("s3: ParseFailures");
  });

  it("includes alert-only tenants (no metrics) and sorts worst-health first", () => {
    const rows = buildFleetSummaries(inputs, makeNameResolver(["BCG"]));
    expect(rows.map((r) => r.tenant)).toContain("alertonly");
    // alertonly has a critical alert -> lowest score -> first
    expect(rows[0].tenant).toBe("alertonly");
    expect(rows[0].severity).toBe("critical");
  });

  it("healthyco with no alerts/errors scores 100", () => {
    const rows = buildFleetSummaries(inputs, makeNameResolver(["BCG"]));
    const h = rows.find((r) => r.tenant === "healthyco")!;
    expect(h.healthScore).toBe(100);
    expect(h.topIssue).toBeNull();
  });
});

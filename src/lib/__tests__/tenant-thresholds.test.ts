import { describe, it, expect } from "vitest";
import {
  DEFAULT_THRESHOLDS,
  compare,
  evaluateMetrics,
  worstSeverity,
  summarizeBreaches,
  mergeRules,
} from "@/lib/tenant-thresholds";
import type {
  IntegrationMetrics,
  ThresholdBreach,
  ThresholdRule,
} from "@/types/tenant";

function metrics(
  integration: string,
  values: IntegrationMetrics["values"],
): IntegrationMetrics {
  return { integration, values, lastExtractionAt: null };
}

describe("compare", () => {
  it("gt is strict (boundary equality is false)", () => {
    expect(compare(11, "gt", 10)).toBe(true);
    expect(compare(10, "gt", 10)).toBe(false);
    expect(compare(9, "gt", 10)).toBe(false);
  });

  it("gte is inclusive at the boundary", () => {
    expect(compare(11, "gte", 10)).toBe(true);
    expect(compare(10, "gte", 10)).toBe(true);
    expect(compare(9, "gte", 10)).toBe(false);
  });

  it("lt is strict (boundary equality is false)", () => {
    expect(compare(9, "lt", 10)).toBe(true);
    expect(compare(10, "lt", 10)).toBe(false);
    expect(compare(11, "lt", 10)).toBe(false);
  });

  it("lte is inclusive at the boundary", () => {
    expect(compare(9, "lte", 10)).toBe(true);
    expect(compare(10, "lte", 10)).toBe(true);
    expect(compare(11, "lte", 10)).toBe(false);
  });
});

describe("evaluateMetrics", () => {
  it("fires the 24h extraction critical at 86401 (gt strict)", () => {
    const out = evaluateMetrics(
      metrics("aws", { extraction_duration_s: 86401 }),
      DEFAULT_THRESHOLDS,
    );
    const labels = out.map((b) => b.rule.label);
    expect(labels).toContain("Extraction SLA (24h)");
    expect(labels).toContain("Extraction slow (12h)"); // 86401 > 43200 too
    const critical = out.find((b) => b.rule.label === "Extraction SLA (24h)")!;
    expect(critical.severity).toBe("critical");
    expect(critical.observed).toBe(86401);
    expect(critical.integration).toBe("aws");
    expect(critical.metric).toBe("extraction_duration_s");
  });

  it("does NOT fire the 24h critical at exactly 86400, but the 12h warning still fires", () => {
    const out = evaluateMetrics(
      metrics("aws", { extraction_duration_s: 86400 }),
      DEFAULT_THRESHOLDS,
    );
    const labels = out.map((b) => b.rule.label);
    expect(labels).not.toContain("Extraction SLA (24h)");
    expect(labels).toContain("Extraction slow (12h)"); // 86400 > 43200
  });

  it("emits no breach for an absent metric", () => {
    // No extraction_duration_s value present.
    const out = evaluateMetrics(
      metrics("aws", { node_count: 5 }),
      DEFAULT_THRESHOLDS,
    );
    const labels = out.map((b) => b.rule.label);
    expect(labels).not.toContain("Extraction SLA (24h)");
    expect(labels).not.toContain("Extraction slow (12h)");
    // node_count 5 is not < 1, so no breach at all.
    expect(out).toEqual([]);
  });

  it("emits only for present metrics", () => {
    const out = evaluateMetrics(
      metrics("aws", { error_count: 3 }),
      DEFAULT_THRESHOLDS,
    );
    expect(out).toHaveLength(1);
    expect(out[0].rule.label).toBe("Has errors");
    expect(out[0].observed).toBe(3);
  });

  it("flags node_count below floor (lt 1)", () => {
    const out = evaluateMetrics(
      metrics("aws", { node_count: 0 }),
      DEFAULT_THRESHOLDS,
    );
    expect(out.map((b) => b.rule.label)).toContain("No nodes extracted");
  });

  it("respects integration scoping: a rule scoped to aws does NOT fire on okta", () => {
    const rules: ThresholdRule[] = [
      {
        metric: "error_count",
        comparator: "gt",
        value: 0,
        severity: "warning",
        label: "AWS errors",
        integration: "aws",
      },
    ];
    expect(
      evaluateMetrics(metrics("okta", { error_count: 5 }), rules),
    ).toEqual([]);
    const onAws = evaluateMetrics(metrics("aws", { error_count: 5 }), rules);
    expect(onAws).toHaveLength(1);
    expect(onAws[0].rule.label).toBe("AWS errors");
  });

  it("unscoped rules fire on any integration", () => {
    const rules: ThresholdRule[] = [
      {
        metric: "error_count",
        comparator: "gt",
        value: 0,
        severity: "warning",
        label: "Any errors",
      },
    ];
    expect(
      evaluateMetrics(metrics("okta", { error_count: 1 }), rules),
    ).toHaveLength(1);
  });

  it("sorts critical breaches before warnings, then by metric key", () => {
    const out = evaluateMetrics(
      metrics("aws", {
        extraction_duration_s: 90000, // critical (24h) + warning (12h)
        parse_duration_s: 20000, // critical (4h)
        error_count: 2, // warning
      }),
      DEFAULT_THRESHOLDS,
    );
    const severities = out.map((b) => b.severity);
    // All criticals precede all warnings.
    const firstWarning = severities.indexOf("warning");
    const lastCritical = severities.lastIndexOf("critical");
    expect(lastCritical).toBeLessThan(firstWarning);
    // Within criticals, sorted by metric key: extraction_ before parse_.
    const criticalMetrics = out
      .filter((b) => b.severity === "critical")
      .map((b) => b.metric);
    expect(criticalMetrics).toEqual(["extraction_duration_s", "parse_duration_s"]);
  });
});

describe("worstSeverity", () => {
  const crit: ThresholdBreach = {
    metric: "extraction_duration_s",
    integration: "aws",
    observed: 1,
    rule: DEFAULT_THRESHOLDS[0],
    severity: "critical",
  };
  const warn: ThresholdBreach = {
    metric: "error_count",
    integration: "aws",
    observed: 1,
    rule: DEFAULT_THRESHOLDS[3],
    severity: "warning",
  };

  it("returns ok for no breaches", () => {
    expect(worstSeverity([])).toBe("ok");
  });

  it("returns warning when only warnings", () => {
    expect(worstSeverity([warn])).toBe("warning");
  });

  it("returns critical when any critical present (mixed)", () => {
    expect(worstSeverity([warn, crit])).toBe("critical");
  });
});

describe("summarizeBreaches", () => {
  function breach(severity: "critical" | "warning"): ThresholdBreach {
    return {
      metric: "error_count",
      integration: "aws",
      observed: 1,
      rule: DEFAULT_THRESHOLDS[3],
      severity,
    };
  }

  it("says 'healthy' for no breaches", () => {
    expect(summarizeBreaches([])).toBe("healthy");
  });

  it("counts mixed severities, critical first", () => {
    expect(
      summarizeBreaches([
        breach("critical"),
        breach("critical"),
        breach("warning"),
      ]),
    ).toBe("2 critical, 1 warning");
  });

  it("reports warnings only when no criticals", () => {
    expect(summarizeBreaches([breach("warning")])).toBe("1 warning");
  });

  it("reports criticals only when no warnings", () => {
    expect(summarizeBreaches([breach("critical")])).toBe("1 critical");
  });
});

describe("mergeRules", () => {
  it("overrides a default by (metric+integration+comparator) key; override wins", () => {
    // Use parse_duration_s which has exactly one default rule, so the key is unique.
    const overrides: ThresholdRule[] = [
      {
        metric: "parse_duration_s",
        comparator: "gt",
        value: 3600, // tighter than the 14400 default
        severity: "critical",
        label: "Parse SLA (1h)",
      },
    ];
    const merged = mergeRules(DEFAULT_THRESHOLDS, overrides);
    // Same length: replaced in place, not appended.
    expect(merged).toHaveLength(DEFAULT_THRESHOLDS.length);
    const matched = merged.filter(
      (r) =>
        r.metric === "parse_duration_s" &&
        r.comparator === "gt" &&
        r.value === 3600,
    );
    expect(matched).toHaveLength(1);
    expect(matched[0].label).toBe("Parse SLA (1h)");
    // The original 14400 default is gone.
    expect(
      merged.some((r) => r.metric === "parse_duration_s" && r.value === 14400),
    ).toBe(false);
  });

  it("replaces every default sharing the same key (duplicate keys collapse to the override)", () => {
    // The two extraction_duration_s 'gt' defaults share key extraction_duration_s||gt,
    // so a single override replaces both occurrences.
    const overrides: ThresholdRule[] = [
      {
        metric: "extraction_duration_s",
        comparator: "gt",
        value: 3600,
        severity: "critical",
        label: "Extraction SLA (1h)",
      },
    ];
    const merged = mergeRules(DEFAULT_THRESHOLDS, overrides);
    expect(merged).toHaveLength(DEFAULT_THRESHOLDS.length);
    const matched = merged.filter(
      (r) => r.metric === "extraction_duration_s" && r.comparator === "gt",
    );
    expect(matched).toHaveLength(2);
    expect(matched.every((r) => r.label === "Extraction SLA (1h)")).toBe(true);
    expect(
      merged.some((r) => r.metric === "extraction_duration_s" && r.value === 86400),
    ).toBe(false);
  });

  it("appends overrides that do not match any default key", () => {
    const overrides: ThresholdRule[] = [
      {
        metric: "edge_count",
        comparator: "lt",
        value: 1,
        severity: "warning",
        label: "No edges",
      },
    ];
    const merged = mergeRules(DEFAULT_THRESHOLDS, overrides);
    expect(merged).toHaveLength(DEFAULT_THRESHOLDS.length + 1);
    expect(merged[merged.length - 1].label).toBe("No edges");
  });

  it("treats integration scope as part of the key (does not collide with unscoped)", () => {
    const overrides: ThresholdRule[] = [
      {
        metric: "error_count",
        comparator: "gt",
        value: 0,
        severity: "critical",
        label: "AWS errors are critical",
        integration: "aws",
      },
    ];
    const merged = mergeRules(DEFAULT_THRESHOLDS, overrides);
    // Unscoped "Has errors" default remains; scoped override is appended.
    expect(merged.some((r) => r.label === "Has errors")).toBe(true);
    expect(merged.some((r) => r.label === "AWS errors are critical")).toBe(true);
    expect(merged).toHaveLength(DEFAULT_THRESHOLDS.length + 1);
  });

  it("is pure: does not mutate its inputs", () => {
    const defaults = DEFAULT_THRESHOLDS.map((r) => ({ ...r }));
    const overrides: ThresholdRule[] = [
      {
        metric: "error_count",
        comparator: "gt",
        value: 0,
        severity: "critical",
        label: "Errors critical",
      },
    ];
    const defaultsSnapshot = JSON.stringify(defaults);
    const overridesSnapshot = JSON.stringify(overrides);
    mergeRules(defaults, overrides);
    expect(JSON.stringify(defaults)).toBe(defaultsSnapshot);
    expect(JSON.stringify(overrides)).toBe(overridesSnapshot);
  });
});

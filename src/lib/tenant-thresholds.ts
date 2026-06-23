/**
 * Tunable thresholds engine for the per-tenant Integrations Health dashboard.
 *
 * Pure, framework-free, deterministic. Metrics are compared against a set of
 * tunable {@link ThresholdRule}s; rules that compare true produce
 * {@link ThresholdBreach}es. This is the "metrics can be tuned to thresholds
 * which determine if there are issues" requirement (e.g. flag extraction > 24h).
 */

import type {
  IntegrationMetrics,
  MetricKey,
  Severity,
  ThresholdBreach,
  ThresholdComparator,
  ThresholdRule,
} from "@/types/tenant";

/**
 * Sensible starting-point thresholds. Tenants may override these via
 * {@link mergeRules}. Durations are in seconds.
 */
export const DEFAULT_THRESHOLDS: ThresholdRule[] = [
  {
    metric: "extraction_duration_s",
    comparator: "gt",
    value: 86400, // 24h
    severity: "critical",
    label: "Extraction SLA (24h)",
  },
  {
    metric: "extraction_duration_s",
    comparator: "gt",
    value: 43200, // 12h
    severity: "warning",
    label: "Extraction slow (12h)",
  },
  {
    metric: "parse_duration_s",
    comparator: "gt",
    value: 14400, // 4h
    severity: "critical",
    label: "Parse SLA (4h)",
  },
  {
    metric: "error_count",
    comparator: "gt",
    value: 0,
    severity: "warning",
    label: "Has errors",
  },
  {
    metric: "node_count",
    comparator: "lt",
    value: 1,
    severity: "warning",
    label: "No nodes extracted",
  },
];

/** Compare an observed value against a threshold value using the comparator. */
export function compare(
  observed: number,
  comparator: ThresholdComparator,
  value: number,
): boolean {
  switch (comparator) {
    case "gt":
      return observed > value;
    case "gte":
      return observed >= value;
    case "lt":
      return observed < value;
    case "lte":
      return observed <= value;
    default: {
      // Exhaustiveness guard; unreachable for valid ThresholdComparator.
      const _never: never = comparator;
      return _never;
    }
  }
}

const SEVERITY_RANK: Record<Exclude<Severity, "ok">, number> = {
  critical: 0,
  warning: 1,
};

/**
 * Evaluate a set of rules against one integration's metrics. A rule fires when:
 *  - its metric is present in `metrics.values` (absent metrics are skipped), AND
 *  - the rule is unscoped (`integration` undefined) or scoped to this integration, AND
 *  - {@link compare} returns true for the observed value.
 *
 * Breaches are sorted critical-before-warning, then by metric key.
 */
export function evaluateMetrics(
  metrics: IntegrationMetrics,
  rules: ThresholdRule[],
): ThresholdBreach[] {
  const breaches: ThresholdBreach[] = [];

  for (const rule of rules) {
    if (rule.integration !== undefined && rule.integration !== metrics.integration) {
      continue;
    }
    const observed = metrics.values[rule.metric];
    if (observed === undefined) {
      continue;
    }
    if (compare(observed, rule.comparator, rule.value)) {
      breaches.push({
        metric: rule.metric,
        integration: metrics.integration,
        observed,
        rule,
        severity: rule.severity,
      });
    }
  }

  breaches.sort((a, b) => {
    const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sev !== 0) return sev;
    return a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : 0;
  });

  return breaches;
}

/** Worst severity across breaches: critical > warning > ok (empty => ok). */
export function worstSeverity(breaches: ThresholdBreach[]): Severity {
  let hasWarning = false;
  for (const b of breaches) {
    if (b.severity === "critical") return "critical";
    if (b.severity === "warning") hasWarning = true;
  }
  return hasWarning ? "warning" : "ok";
}

/** Short human summary, e.g. "2 critical, 1 warning" or "healthy". */
export function summarizeBreaches(breaches: ThresholdBreach[]): string {
  let critical = 0;
  let warning = 0;
  for (const b of breaches) {
    if (b.severity === "critical") critical++;
    else if (b.severity === "warning") warning++;
  }
  if (critical === 0 && warning === 0) return "healthy";

  const parts: string[] = [];
  if (critical > 0) parts.push(`${critical} critical`);
  if (warning > 0) parts.push(`${warning} warning`);
  return parts.join(", ");
}

function ruleKey(rule: ThresholdRule): string {
  return `${rule.metric}|${rule.integration ?? ""}|${rule.comparator}`;
}

/**
 * Merge override rules onto defaults. Rules are keyed by
 * (metric + integration + comparator); an override with a matching key replaces
 * the default, otherwise it is appended. Pure: inputs are not mutated, and the
 * relative order of defaults is preserved (new overrides appended in order).
 */
export function mergeRules(
  defaults: ThresholdRule[],
  overrides: ThresholdRule[],
): ThresholdRule[] {
  const overrideByKey = new Map<string, ThresholdRule>();
  for (const o of overrides) {
    overrideByKey.set(ruleKey(o), o);
  }

  const usedKeys = new Set<string>();
  const merged: ThresholdRule[] = defaults.map((d) => {
    const key = ruleKey(d);
    const override = overrideByKey.get(key);
    if (override) {
      usedKeys.add(key);
      return override;
    }
    return d;
  });

  for (const o of overrides) {
    const key = ruleKey(o);
    if (!usedKeys.has(key)) {
      usedKeys.add(key);
      merged.push(o);
    }
  }

  return merged;
}

export type { MetricKey };

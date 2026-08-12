import type { AppConfig, Scope } from "@/types/triage";

/**
 * Pure config logic — defaults, parsing/migration, and merge. Kept free of any
 * storage (db) import so it can be unit-tested without pulling in node:sqlite.
 */

export const DEFAULTS: AppConfig = {
  jqls: {
    eac: "project = EAC AND statusCategory != Done ORDER BY updated DESC",
    fr: "project = FR AND statusCategory != Done ORDER BY updated DESC",
    sec: 'project = EAC AND (labels in (security, vulnerability, pii) OR "Issue Type" in ("Vulnerability", "Security")) AND statusCategory != Done ORDER BY priority DESC, updated DESC',
    alerts: 'labels = "integrations:on-call-triage" AND statusCategory != Done ORDER BY priority DESC, updated DESC',
    incidents:
      "labels = incident-action-item AND statusCategory NOT IN (Done) AND component in (integrations) ORDER BY priority DESC, created DESC",
    alldefects:
      "project = EAC and component in (Integrations) and statusCategory != Done and issuetype = Bug and createdDate >= '2026-01-01 00:00' ORDER BY created ASC, priority DESC, updated DESC",
    ops: "project = OPS and assignee = 62c87d212c528400c9b7618f and status != Done ORDER BY priority DESC, updated DESC",
    automation:
      "project = EAC and reporter in (712020:c6d4269a-0c97-4c14-83aa-acd4282ce1aa, 712020:a20fd403-2a10-49ca-9ce1-393a1b9e8209, 712020:085da38d-f61f-4cba-bbfc-04d3f1df5c1a) and status not in (Done) and issuetype = Bug",
  },
  dashboards: {
    eac: true,
    fr: true,
    sec: true,
    alerts: true,
    incidents: true,
    alldefects: true,
    ops: true,
    automation: true,
  },
  siJql:
    "project = INTEG AND issuetype in (Bug, Defect) AND labels = strategic-integration ORDER BY created DESC",
  siDashboard: true,
  tenantDashboard: true,
  pdaJql:
    'project = EAC AND issuetype in (Bug) AND "Customer[Select List (multiple choices)]" is not EMPTY and created >= -400d',
  pdaDashboard: true,
  codeRepoPath: "/Users/ricky.koo/veza/cookieai-core",
  sprintLengthDays: 14,
  inactivityThresholdDays: 21,
  pingThresholdDays: 7,
  model: process.env.ANTHROPIC_MODEL || "claude-opus-4-7",
  maxIssuesPerSync: 500,
};

interface RawConfig extends Partial<Omit<AppConfig, "jqls" | "dashboards">> {
  jqls?: Partial<Record<Scope, string>>;
  dashboards?: Partial<Record<Scope, boolean>>;
  /** Legacy field before per-scope JQLs. Migrated to jqls.eac on read. */
  masterJql?: string;
}

export function defaults(): AppConfig {
  return {
    ...DEFAULTS,
    jqls: { ...DEFAULTS.jqls },
    dashboards: { ...DEFAULTS.dashboards },
  };
}

/**
 * Turn a stored config string (or null/garbage) into a complete AppConfig,
 * applying defaults and legacy migrations.
 */
export function parseConfig(raw: string | null): AppConfig {
  if (!raw) return defaults();
  let parsed: RawConfig;
  try {
    parsed = JSON.parse(raw) as RawConfig;
  } catch {
    return defaults();
  }
  const jqls: Record<Scope, string> = {
    eac: parsed.jqls?.eac ?? parsed.masterJql ?? DEFAULTS.jqls.eac,
    fr: parsed.jqls?.fr ?? DEFAULTS.jqls.fr,
    sec: parsed.jqls?.sec ?? DEFAULTS.jqls.sec,
    alerts: parsed.jqls?.alerts ?? DEFAULTS.jqls.alerts,
    incidents: parsed.jqls?.incidents ?? DEFAULTS.jqls.incidents,
    alldefects: parsed.jqls?.alldefects ?? DEFAULTS.jqls.alldefects,
    ops: parsed.jqls?.ops ?? DEFAULTS.jqls.ops,
    automation: parsed.jqls?.automation ?? DEFAULTS.jqls.automation,
  };
  const dashboards: Record<Scope, boolean> = {
    eac: parsed.dashboards?.eac ?? true,
    fr: parsed.dashboards?.fr ?? true,
    sec: parsed.dashboards?.sec ?? true,
    alerts: parsed.dashboards?.alerts ?? true,
    incidents: parsed.dashboards?.incidents ?? true,
    alldefects: parsed.dashboards?.alldefects ?? true,
    ops: parsed.dashboards?.ops ?? true,
    automation: parsed.dashboards?.automation ?? true,
  };
  return {
    ...DEFAULTS,
    ...parsed,
    jqls,
    dashboards,
    siJql: parsed.siJql ?? DEFAULTS.siJql,
    siDashboard: parsed.siDashboard ?? DEFAULTS.siDashboard,
    tenantDashboard: parsed.tenantDashboard ?? DEFAULTS.tenantDashboard,
    pdaJql: parsed.pdaJql ?? DEFAULTS.pdaJql,
    pdaDashboard: parsed.pdaDashboard ?? DEFAULTS.pdaDashboard,
    codeRepoPath: parsed.codeRepoPath ?? DEFAULTS.codeRepoPath,
  };
}

export type AppConfigPatch = Partial<Omit<AppConfig, "jqls" | "dashboards">> & {
  jqls?: Partial<Record<Scope, string>>;
  dashboards?: Partial<Record<Scope, boolean>>;
};

/** Merge a patch onto a base config, deep-merging the nested records. */
export function mergeConfig(current: AppConfig, partial: AppConfigPatch): AppConfig {
  return {
    ...current,
    ...partial,
    jqls: { ...current.jqls, ...(partial.jqls ?? {}) },
    dashboards: { ...current.dashboards, ...(partial.dashboards ?? {}) },
  };
}

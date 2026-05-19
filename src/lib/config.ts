import type { AppConfig, Scope } from "@/types/triage";
import { getConfigValue, setConfigValue } from "./db";

const DEFAULTS: AppConfig = {
  jqls: {
    eac: "project = EAC AND statusCategory != Done ORDER BY updated DESC",
    fr: "project = FR AND statusCategory != Done ORDER BY updated DESC",
    sec: 'project = EAC AND (labels in (security, vulnerability, pii) OR "Issue Type" in ("Vulnerability", "Security")) AND statusCategory != Done ORDER BY priority DESC, updated DESC',
  },
  dashboards: { eac: true, fr: true, sec: true },
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

function defaults(): AppConfig {
  return {
    ...DEFAULTS,
    jqls: { ...DEFAULTS.jqls },
    dashboards: { ...DEFAULTS.dashboards },
  };
}

export function getConfig(): AppConfig {
  const raw = getConfigValue("app");
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
  };
  const dashboards: Record<Scope, boolean> = {
    eac: parsed.dashboards?.eac ?? true,
    fr: parsed.dashboards?.fr ?? true,
    sec: parsed.dashboards?.sec ?? true,
  };
  return {
    ...DEFAULTS,
    ...parsed,
    jqls,
    dashboards,
  };
}

export type AppConfigPatch = Partial<Omit<AppConfig, "jqls" | "dashboards">> & {
  jqls?: Partial<Record<Scope, string>>;
  dashboards?: Partial<Record<Scope, boolean>>;
};

export function saveConfig(partial: AppConfigPatch): AppConfig {
  const current = getConfig();
  const next: AppConfig = {
    ...current,
    ...partial,
    jqls: { ...current.jqls, ...(partial.jqls ?? {}) },
    dashboards: { ...current.dashboards, ...(partial.dashboards ?? {}) },
  };
  setConfigValue("app", JSON.stringify(next));
  return next;
}

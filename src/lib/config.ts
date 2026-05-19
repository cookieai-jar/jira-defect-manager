import type { AppConfig } from "@/types/triage";
import { getConfigValue, setConfigValue } from "./db";

const DEFAULTS: AppConfig = {
  masterJql: 'project = SUP AND statusCategory != Done ORDER BY updated DESC',
  sprintLengthDays: 14,
  inactivityThresholdDays: 21,
  pingThresholdDays: 7,
  model: process.env.ANTHROPIC_MODEL || "claude-opus-4-7",
  maxIssuesPerSync: 200,
};

export function getConfig(): AppConfig {
  const raw = getConfigValue("app");
  if (!raw) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AppConfig>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(partial: Partial<AppConfig>): AppConfig {
  const next = { ...getConfig(), ...partial };
  setConfigValue("app", JSON.stringify(next));
  return next;
}

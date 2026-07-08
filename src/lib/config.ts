import type { AppConfig } from "@/types/triage";
import { getConfigValue, setConfigValue } from "./db";
import { mergeConfig, parseConfig, type AppConfigPatch } from "./config-core";

export { defaults, parseConfig, mergeConfig, DEFAULTS } from "./config-core";
export type { AppConfigPatch } from "./config-core";

export function getConfig(): AppConfig {
  return parseConfig(getConfigValue("app"));
}

export function saveConfig(partial: AppConfigPatch): AppConfig {
  const next = mergeConfig(getConfig(), partial);
  setConfigValue("app", JSON.stringify(next));
  return next;
}

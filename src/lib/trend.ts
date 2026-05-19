import { searchTrendKeys } from "./jira";
import { stripDynamicClauses } from "./jql";
import type { TrendBucket } from "@/types/triage";

function projectClause(masterJql: string): string | null {
  const m = masterJql.match(/\bproject\s*(?:=|in)\s*([A-Za-z0-9_-]+|"[^"]+"|\([^)]+\))/i);
  if (!m) return null;
  const rhs = m[0].split(/\bproject\s*/i)[1];
  return `project ${rhs}`;
}

function buildBaseFilter(masterJql: string): string {
  const stripped = stripDynamicClauses(masterJql);
  if (stripped) return stripped;
  const project = projectClause(masterJql);
  return project ?? "project is not empty";
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function computeTrend(
  masterJql: string,
  days = 30,
): Promise<TrendBucket[]> {
  const base = buildBaseFilter(masterJql);
  const createdJql = `${base} AND created >= -${days}d`;
  const resolvedJql = `${base} AND resolutiondate >= -${days}d`;

  const [created, resolved] = await Promise.all([
    searchTrendKeys(createdJql, 2000),
    searchTrendKeys(resolvedJql, 2000),
  ]);

  // Initialize buckets for the past `days` days, oldest first.
  const buckets = new Map<string, TrendBucket>();
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const key = ymd(d);
    buckets.set(key, { date: key, created: 0, resolved: 0 });
  }

  for (const issue of created) {
    if (!issue.created) continue;
    const day = issue.created.slice(0, 10);
    const b = buckets.get(day);
    if (b) b.created++;
  }
  for (const issue of resolved) {
    if (!issue.resolved) continue;
    const day = issue.resolved.slice(0, 10);
    const b = buckets.get(day);
    if (b) b.resolved++;
  }
  return Array.from(buckets.values());
}

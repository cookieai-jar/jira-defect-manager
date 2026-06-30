/**
 * Pure, client-safe digest of the watched tenants (white-glove ∪ starred) — what
 * needs attention right now, computed from the fleet summary already on hand.
 * No new data source; just a focused roll-up of health/delta/alerts/backlog.
 */
import type { FleetTenantSummary } from "@/types/tenant";

/** A health-score drop of at least this many points counts as "degraded". */
export const DEGRADED_DROP = 10;
/** Below this score a tenant is "unhealthy" (matches the red tier). */
export const UNHEALTHY_SCORE = 50;

export interface WatchDigestItem {
  tenant: string;
  displayName: string;
  whiteGlove: boolean;
  healthScore: number;
  healthDelta: number | null;
  criticalAlerts: number;
  pendingExtractJobs: number;
  /** Why this tenant is flagged (empty ⇒ steady). */
  reasons: string[];
}

export interface WatchDigest {
  /** Total watched tenants considered. */
  total: number;
  /** Flagged tenants, worst-health first. */
  attention: WatchDigestItem[];
  /** Watched tenants with nothing flagged. */
  steadyCount: number;
}

/** PURE. Reasons a watched tenant needs attention (most severe first). */
export function attentionReasons(t: FleetTenantSummary): string[] {
  const reasons: string[] = [];
  if (t.criticalAlerts > 0) reasons.push(`${t.criticalAlerts} critical alert${t.criticalAlerts === 1 ? "" : "s"}`);
  if (t.healthScore < UNHEALTHY_SCORE) reasons.push(`unhealthy (${t.healthScore}/100)`);
  if (t.healthDelta != null && t.healthDelta <= -DEGRADED_DROP) reasons.push(`dropped ${Math.abs(t.healthDelta)} pts`);
  return reasons;
}

/**
 * PURE. Build the watch-list digest from the already-watched tenant summaries.
 * Caller decides membership (white-glove ∪ starred) and passes that subset.
 */
export function buildWatchDigest(watched: FleetTenantSummary[]): WatchDigest {
  const attention: WatchDigestItem[] = [];
  let steadyCount = 0;
  for (const t of watched) {
    const reasons = attentionReasons(t);
    if (reasons.length === 0) {
      steadyCount += 1;
      continue;
    }
    attention.push({
      tenant: t.tenant,
      displayName: t.displayName,
      whiteGlove: t.whiteGlove,
      healthScore: t.healthScore,
      healthDelta: t.healthDelta,
      criticalAlerts: t.criticalAlerts,
      pendingExtractJobs: t.pendingExtractJobs,
      reasons,
    });
  }
  attention.sort((a, b) => a.healthScore - b.healthScore || b.criticalAlerts - a.criticalAlerts);
  return { total: watched.length, attention, steadyCount };
}

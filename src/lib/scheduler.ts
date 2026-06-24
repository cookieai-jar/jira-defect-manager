import { SCOPES, type AppConfig, type Scope } from "@/types/triage";

/**
 * Server-side hourly auto-sync. A browser `setInterval` can't keep data fresh
 * (it only runs while a tab is open & foregrounded), so the Next server itself
 * drives the sync on a timer — see src/instrumentation.ts. The decision logic is
 * pure and unit-tested; startAutoSync wires it to the real db/sync.
 */

export const DEFAULT_SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/** Triage scopes eligible for auto-sync: those whose dashboard is enabled. */
export function autoSyncScopes(config: Pick<AppConfig, "dashboards">): Scope[] {
  return SCOPES.filter((s) => config.dashboards?.[s] !== false);
}

/**
 * PURE. Is a scope due for a sync? Due when never synced, when the last-sync
 * timestamp is unparseable, or when it finished at least `intervalMs` ago.
 */
export function dueForSync(
  finishedAt: string | null | undefined,
  now: number,
  intervalMs: number,
): boolean {
  if (!finishedAt) return true;
  const t = Date.parse(finishedAt);
  if (Number.isNaN(t)) return true;
  return now - t >= intervalMs;
}

export interface ScopeSyncSnapshot {
  running: boolean;
  finishedAt: string | null;
}

export interface SchedulerTickDeps {
  scopes: Scope[];
  now: number;
  intervalMs: number;
  getState: (scope: Scope) => ScopeSyncSnapshot;
  trigger: (scope: Scope) => void;
}

/**
 * PURE-ish. One scheduler pass: trigger a sync for every scope that is not
 * already running and is due. Returns the scopes it triggered. Side effects are
 * confined to the injected `trigger`, so this is fully unit-testable.
 */
export function runSchedulerTick(deps: SchedulerTickDeps): Scope[] {
  const triggered: Scope[] = [];
  for (const scope of deps.scopes) {
    const st = deps.getState(scope);
    if (st.running) continue;
    if (!dueForSync(st.finishedAt, deps.now, deps.intervalMs)) continue;
    deps.trigger(scope);
    triggered.push(scope);
  }
  return triggered;
}

/**
 * Start the server-side auto-sync timer (idempotent across HMR via a global
 * guard). Runs an initial pass shortly after boot (so a stale dashboard is
 * refreshed without waiting a full interval), then every `intervalMs`. Returns
 * a stop function. Dynamically imports db/sync deps so this module stays cheap
 * to import from pure tests.
 */
export async function startAutoSync(
  intervalMs: number = DEFAULT_SYNC_INTERVAL_MS,
): Promise<() => void> {
  const g = globalThis as unknown as { __autoSyncStop?: () => void };
  if (g.__autoSyncStop) return g.__autoSyncStop; // already running (HMR / double register)

  const [{ getConfig }, { getSyncState }, { triggerSync }, { latestSyncRun }] = await Promise.all([
    import("@/lib/config"),
    import("@/lib/sync-state"),
    import("@/lib/sync-runner"),
    import("@/lib/db"),
  ]);

  // SQLite CURRENT_TIMESTAMP is "YYYY-MM-DD HH:MM:SS" in UTC (no zone marker).
  const dbTimeToIso = (s: string | null | undefined): string | null =>
    s ? new Date(`${s.replace(" ", "T")}Z`).toISOString() : null;

  const tick = () => {
    try {
      const triggered = runSchedulerTick({
        scopes: autoSyncScopes(getConfig()),
        now: Date.now(),
        intervalMs,
        getState: (scope) => {
          // `running` from in-memory (this process's own in-flight syncs);
          // `finishedAt` from the DB so the due-check survives restarts.
          const inMem = getSyncState(scope);
          const row = latestSyncRun(scope) as { finished_at?: string | null } | undefined;
          return { running: inMem.running, finishedAt: dbTimeToIso(row?.finished_at) ?? inMem.finishedAt };
        },
        trigger: (scope) => triggerSync(scope),
      });
      if (triggered.length > 0) {
        console.log(`[auto-sync] triggered: ${triggered.join(", ")}`);
      }
    } catch (err) {
      console.warn("[auto-sync] tick failed:", err instanceof Error ? err.message : err);
    }
  };

  // Initial pass 15s after boot (let the server settle), then on the interval.
  const initial = setTimeout(tick, 15_000);
  const handle = setInterval(tick, intervalMs);
  const stop = () => {
    clearTimeout(initial);
    clearInterval(handle);
    delete g.__autoSyncStop;
  };
  g.__autoSyncStop = stop;
  console.log(`[auto-sync] scheduler started (every ${Math.round(intervalMs / 60000)}m)`);
  return stop;
}

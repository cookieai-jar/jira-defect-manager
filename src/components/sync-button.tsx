"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { RefreshCw, Loader2 } from "lucide-react";
import type { SyncState } from "@/lib/sync-state";
import type { Scope } from "@/types/triage";
import { SCOPE_LABELS } from "@/types/triage";

interface Props {
  scope: Scope;
  onSynced?: () => void;
  /**
   * When set, the button keeps a steady idle poll so the "Last sync" indicator
   * reflects server-scheduler/background syncs and the dashboard refetches when
   * one completes. The actual hourly triggering is done server-side (see
   * src/lib/scheduler.ts); this is only the view-refresh cadence.
   */
  autoRefreshMs?: number;
}

export function SyncButton({ scope, onSynced, autoRefreshMs }: Props) {
  const [state, setState] = useState<SyncState | null>(null);

  // Refs let the single polling loop see fresh values without re-subscribing.
  const onSyncedRef = useRef(onSynced);
  onSyncedRef.current = onSynced;
  const lastFinishedRef = useRef<string | null | undefined>(undefined);
  const kickRef = useRef<() => void>(() => {});

  // Steady poll: fast (1.2s) while a sync is running, slow (idle cadence) when
  // not — so the indicator reflects server-scheduler/background syncs, and the
  // dashboard refetches when one completes. Triggering is the server's job now.
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const idleMs = autoRefreshMs ? 60_000 : null;

    async function tick() {
      clearTimeout(timer);
      try {
        const s = (await fetch(`/api/sync?scope=${scope}`).then((r) => r.json())) as SyncState;
        if (stop) return;
        setState(s);
        if (!s.running) {
          // Refetch the report whenever a sync completes (local OR background).
          const prev = lastFinishedRef.current;
          if (prev === undefined) {
            lastFinishedRef.current = s.finishedAt ?? null; // first observation, no refetch
          } else if (s.finishedAt && s.finishedAt !== prev) {
            lastFinishedRef.current = s.finishedAt;
            onSyncedRef.current?.();
          }
        }
        const delay = s.running ? 1200 : idleMs;
        if (delay != null) timer = setTimeout(tick, delay);
      } catch {
        if (!stop) timer = setTimeout(tick, 2000);
      }
    }

    kickRef.current = () => {
      clearTimeout(timer);
      void tick();
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [scope, autoRefreshMs]);

  async function start() {
    const res = await fetch(`/api/sync?scope=${scope}`, { method: "POST" });
    if (!res.ok && res.status !== 202) {
      const err = await res.json().catch(() => ({}));
      alert(`Sync failed: ${err.error ?? res.statusText}`);
    }
    kickRef.current(); // poll immediately so the spinner/progress show right away
  }

  const running = state?.running ?? false;
  const pct = state?.total ? Math.round((state.done / state.total) * 100) : 0;

  return (
    <div className="flex items-center gap-3">
      {running && state ? (
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
          <span className="font-mono">{state.phase}</span>
          <span>{state.message}</span>
          {state.total > 0 && (
            <div className="h-1.5 w-24 rounded-full bg-bg-muted overflow-hidden border border-border">
              <div
                className="h-full bg-accent transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
        </div>
      ) : state?.finishedAt ? (
        <span className="text-[11px] text-fg-subtle">
          Last {SCOPE_LABELS[scope]} sync: {new Date(state.finishedAt).toLocaleString()}
          {autoRefreshMs && <span className="text-fg-subtle"> · auto-syncs hourly</span>}
          {state.error && <span className="text-danger ml-2">· {state.error}</span>}
        </span>
      ) : autoRefreshMs ? (
        <span className="text-[11px] text-fg-subtle">auto-syncs hourly</span>
      ) : null}
      <Button onClick={() => start()} disabled={running}>
        {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        {running ? "Syncing…" : `Sync ${SCOPE_LABELS[scope]} from JIRA`}
      </Button>
    </div>
  );
}

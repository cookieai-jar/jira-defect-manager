"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { RefreshCw, Loader2 } from "lucide-react";
import type { SyncState } from "@/lib/sync-state";

interface Props {
  onSynced?: () => void;
}

export function SyncButton({ onSynced }: Props) {
  const [state, setState] = useState<SyncState | null>(null);
  const [polling, setPolling] = useState(false);

  useEffect(() => {
    let stop = false;
    async function tick() {
      try {
        const s = (await fetch("/api/sync").then((r) => r.json())) as SyncState;
        if (!stop) setState(s);
        if (s.running) {
          setTimeout(tick, 1200);
        } else if (polling) {
          setPolling(false);
          onSynced?.();
        }
      } catch {
        if (!stop) setTimeout(tick, 2000);
      }
    }
    tick();
    return () => {
      stop = true;
    };
  }, [polling, onSynced]);

  async function start() {
    setPolling(true);
    const res = await fetch("/api/sync", { method: "POST" });
    if (!res.ok && res.status !== 202) {
      const err = await res.json().catch(() => ({}));
      alert(`Sync failed: ${err.error ?? res.statusText}`);
      setPolling(false);
    }
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
          Last sync: {new Date(state.finishedAt).toLocaleString()}
          {state.error && <span className="text-danger ml-2">· {state.error}</span>}
        </span>
      ) : null}
      <Button onClick={start} disabled={running}>
        {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
        {running ? "Syncing…" : "Sync from JIRA"}
      </Button>
    </div>
  );
}

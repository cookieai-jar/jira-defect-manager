"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { RefreshCw, Loader2 } from "lucide-react";
import type {
  ProductDefectsPhase,
  ProductDefectsSyncState,
} from "@/lib/product-defects-sync-state";

interface Props {
  onSynced?: () => void;
}

/**
 * Human labels for the pipeline phases. The raw phase slugs are terse enough to
 * be cryptic to a reader who is not the person who wrote the pipeline, and this
 * run is long (~1300 tickets), so the label has to say what we are waiting on.
 */
const PHASE_LABELS: Record<ProductDefectsPhase, string> = {
  idle: "Idle",
  jira: "Pulling tickets",
  correlate: "Correlating code",
  metrics: "Computing metrics",
  extract: "Extracting signals",
  synthesize: "Synthesizing groups",
  "deep-dive": "Deep-diving groups",
  strategies: "Building strategies",
  teams: "Team action plans",
  components: "Analyzing components",
  done: "Done",
  error: "Failed",
};

/** Phases in run order, so the pill can show "step 4 of 8" style progress. */
const PHASE_ORDER: ProductDefectsPhase[] = [
  "jira",
  "correlate",
  "metrics",
  "extract",
  "synthesize",
  "deep-dive",
  "strategies",
  "teams",
];

/**
 * Kicks off the Product Defect Analysis pipeline and polls its progress.
 * Mirrors IntegrationsSyncButton; the only differences are the endpoint and the
 * longer phase list, which is worth surfacing because a full run is slow.
 */
export function ProductDefectsSyncButton({ onSynced }: Props) {
  const [state, setState] = useState<ProductDefectsSyncState | null>(null);
  const [polling, setPolling] = useState(false);

  useEffect(() => {
    let stop = false;
    async function tick() {
      try {
        const s = (await fetch("/api/product-defects/sync").then((r) =>
          r.json(),
        )) as ProductDefectsSyncState;
        if (stop) return;
        setState(s);
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
    const res = await fetch("/api/product-defects/sync", { method: "POST" });
    if (!res.ok && res.status !== 202) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      alert(`Sync failed: ${err.error ?? res.statusText}`);
      setPolling(false);
    }
  }

  const running = state?.running ?? false;
  const pct = state?.total ? Math.round((state.done / state.total) * 100) : 0;
  const step = state ? PHASE_ORDER.indexOf(state.phase) + 1 : 0;

  return (
    <div className="flex items-center gap-3">
      {running && state ? (
        <div className="flex items-center gap-2 text-xs text-fg-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
          <span className="font-medium text-fg">{PHASE_LABELS[state.phase]}</span>
          {step > 0 && (
            <span className="font-mono text-[10px] text-fg-subtle">
              {step}/{PHASE_ORDER.length}
            </span>
          )}
          <span className="max-w-[22rem] truncate">{state.message}</span>
          {state.total > 0 && (
            <>
              <div
                className="h-1.5 w-24 rounded-full bg-bg-muted overflow-hidden border border-border"
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Analysis progress"
              >
                <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
              </div>
              <span className="font-mono text-[10px] text-fg-subtle">
                {state.done}/{state.total}
              </span>
            </>
          )}
        </div>
      ) : state?.finishedAt ? (
        <span className="text-[11px] text-fg-subtle">
          Last analysis: {new Date(state.finishedAt).toLocaleString()}
          {state.error && <span className="text-danger ml-2">· {state.error}</span>}
        </span>
      ) : null}
      <Button onClick={start} disabled={running}>
        {running ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <RefreshCw className="h-3.5 w-3.5" />
        )}
        {running ? "Analyzing…" : "Sync & Analyze"}
      </Button>
    </div>
  );
}

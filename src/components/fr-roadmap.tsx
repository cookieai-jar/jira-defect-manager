"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarClock, ChevronRight, ExternalLink, RefreshCw, ShieldAlert } from "lucide-react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusChip } from "@/components/jira-chips";
import { cn } from "@/lib/utils";
import type { CommittedRoadmap, CommittedMonth, RoadmapFr, RoadmapDependency } from "@/types/triage";

export function FrRoadmap() {
  const [roadmap, setRoadmap] = useState<CommittedRoadmap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [openFrs, setOpenFrs] = useState<Set<string>>(new Set());
  const [openMonths, setOpenMonths] = useState<Set<string> | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = (await fetch("/api/fr/roadmap").then((r) => r.json())) as {
        roadmap: CommittedRoadmap | null;
        error?: string;
      };
      setRoadmap(data.roadmap);
      setError(data.error ?? null);
      // Default: expand current + future months, collapse past ones.
      if (data.roadmap) {
        setOpenMonths(new Set(data.roadmap.months.filter((m) => !m.isPast).map((m) => m.key)));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load roadmap");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const toggleFr = (key: string) =>
    setOpenFrs((s) => {
      const next = new Set(s);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  const toggleMonth = (key: string) =>
    setOpenMonths((s) => {
      const next = new Set(s ?? []);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const totals = roadmap
    ? roadmap.months.reduce(
        (acc, m) => ({ frs: acc.frs + m.frCount, blockers: acc.blockers + m.blockerCount }),
        { frs: 0, blockers: 0 },
      )
    : { frs: 0, blockers: 0 };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-accent" /> Committed roadmap
          </CardTitle>
          <span className="text-[11px] text-fg-subtle">
            FRs by targeted month
            {roadmap && roadmap.months.length > 0 && (
              <>
                {" "}· {totals.frs} committed across {roadmap.months.length} months
                {totals.blockers > 0 && <span className="text-danger"> · {totals.blockers} blockers</span>}
              </>
            )}
          </span>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="inline-flex items-center gap-1.5 text-[11px] text-fg-subtle hover:text-accent transition-colors disabled:opacity-60"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /> Refresh
        </button>
      </CardHeader>
      <CardBody className="space-y-3">
        {loading && !roadmap ? (
          <p className="text-sm text-fg-muted">Loading committed roadmap…</p>
        ) : error && !roadmap ? (
          <p className="text-sm text-danger">Couldn&apos;t load roadmap: {error}</p>
        ) : !roadmap || (roadmap.months.length === 0 && roadmap.dropped.length === 0) ? (
          <p className="text-sm text-fg-muted">No FRs have a Targeted Month set.</p>
        ) : (
          <>
            {roadmap.months.map((m) => (
              <MonthGroup
                key={m.key}
                month={m}
                open={openMonths?.has(m.key) ?? false}
                onToggle={() => toggleMonth(m.key)}
                openFrs={openFrs}
                onToggleFr={toggleFr}
              />
            ))}
            {roadmap.dropped.length > 0 && (
              <div className="rounded border border-warning/40 bg-warning/5 px-3 py-2 text-[11px] text-fg-muted">
                <span className="font-medium text-warning">
                  {roadmap.dropped.length} FR{roadmap.dropped.length === 1 ? "" : "s"} with an unrecognized Targeted Month:
                </span>{" "}
                {roadmap.dropped.map((d) => `${d.key} (${d.rawValue})`).join(", ")}
              </div>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}

function MonthGroup({
  month,
  open,
  onToggle,
  openFrs,
  onToggleFr,
}: {
  month: CommittedMonth;
  open: boolean;
  onToggle: () => void;
  openFrs: Set<string>;
  onToggleFr: (key: string) => void;
}) {
  return (
    <div className={cn("rounded border border-border", month.isPast && "opacity-70")}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-bg-muted/40 transition-colors"
      >
        <ChevronRight className={cn("h-4 w-4 text-fg-subtle transition-transform", open && "rotate-90")} />
        <span className="font-semibold text-fg">{month.label}</span>
        {month.isPast && <span className="text-[10px] uppercase tracking-wide text-fg-subtle">past</span>}
        <span className="ml-auto flex items-center gap-2 text-[11px] text-fg-subtle">
          <span>
            {month.frCount} FR{month.frCount === 1 ? "" : "s"} · {month.childCount} epic
            {month.childCount === 1 ? "" : "s"}
          </span>
          {month.blockerCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded border border-danger/40 bg-danger/10 px-1.5 py-0.5 font-mono text-danger">
              <ShieldAlert className="h-3 w-3" />
              {month.blockerCount}
            </span>
          )}
        </span>
      </button>
      {open && (
        <div className="divide-y divide-border/60 border-t border-border/60">
          {month.frs.map((fr) => (
            <FrRow key={fr.key} fr={fr} open={openFrs.has(fr.key)} onToggle={() => onToggleFr(fr.key)} />
          ))}
        </div>
      )}
    </div>
  );
}

function FrRow({ fr, open, onToggle }: { fr: RoadmapFr; open: boolean; onToggle: () => void }) {
  return (
    <div>
      <div className="flex items-center gap-2 px-3 py-1.5 hover:bg-bg-muted/20">
        <button type="button" onClick={onToggle} className="inline-flex shrink-0 text-fg-subtle hover:text-accent">
          <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
        </button>
        <a
          href={fr.url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="font-mono text-xs font-semibold text-accent hover:underline shrink-0"
        >
          {fr.key}
        </a>
        <span className="truncate text-sm text-fg" title={fr.summary}>
          {fr.summary}
        </span>
        <span className="ml-auto flex items-center gap-2 shrink-0">
          {fr.blockerCount > 0 && (
            <span
              className="inline-flex items-center gap-1 text-[10px] font-mono text-danger"
              title={`${fr.blockerCount} unresolved blocker(s)`}
            >
              <ShieldAlert className="h-3 w-3" />
              {fr.blockerCount}
            </span>
          )}
          {fr.children.length > 0 && (
            <span className="text-[10px] text-fg-subtle">
              {fr.children.length} epic{fr.children.length === 1 ? "" : "s"}
            </span>
          )}
          <StatusChip status={fr.status} />
        </span>
      </div>
      {open && (
        <div className="space-y-2 bg-bg-muted/20 px-3 py-2 pl-9">
          <DependencyList deps={fr.dependencies} label="FR dependencies" />
          {fr.children.length === 0 ? (
            <p className="text-[11px] text-fg-subtle">No child EAC tickets linked.</p>
          ) : (
            <div className="space-y-1.5">
              <div className="text-[10px] uppercase tracking-wide text-fg-subtle">Child EAC tickets</div>
              {fr.children.map((c) => (
                <div key={c.key} className="rounded border border-border bg-bg-card px-2.5 py-1.5">
                  <div className="flex items-center gap-2">
                    <a
                      href={c.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 font-mono text-[11px] font-semibold text-accent hover:underline shrink-0"
                    >
                      {c.key}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                    <span className="text-[10px] text-fg-subtle shrink-0">{c.type}</span>
                    <span className="truncate text-xs text-fg-muted" title={c.summary}>
                      {c.summary}
                    </span>
                    <span className="ml-auto shrink-0">
                      <StatusChip status={c.status} />
                    </span>
                  </div>
                  {c.dependencies.length > 0 && (
                    <div className="mt-1.5 pl-1">
                      <DependencyList deps={c.dependencies} label={null} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const DIRECTION_LABEL: Record<RoadmapDependency["direction"], string> = {
  "blocked-by": "blocked by",
  "depends-on": "depends on",
  blocks: "blocks",
  relates: "relates to",
};

function DependencyList({ deps, label }: { deps: RoadmapDependency[]; label: string | null }) {
  if (deps.length === 0) return null;
  return (
    <div className="space-y-0.5">
      {label && <div className="text-[10px] uppercase tracking-wide text-fg-subtle">{label}</div>}
      {deps.map((d, i) => (
        <div
          key={`${d.key}-${i}`}
          className={cn(
            "flex items-center gap-1.5 text-[11px]",
            d.isBlocker && "rounded bg-danger/10 px-1.5 py-0.5",
          )}
        >
          {d.isBlocker && <ShieldAlert className="h-3 w-3 shrink-0 text-danger" />}
          <span className={cn("shrink-0", d.isBlocker ? "text-danger font-medium" : "text-fg-subtle")}>
            {DIRECTION_LABEL[d.direction]}
          </span>
          <a
            href={d.url}
            target="_blank"
            rel="noreferrer"
            className="font-mono font-semibold text-accent hover:underline shrink-0"
          >
            {d.key}
          </a>
          <span className="truncate text-fg-muted" title={d.summary}>
            {d.summary}
          </span>
          <span className="ml-auto shrink-0">
            <StatusChip status={d.status} />
          </span>
        </div>
      ))}
    </div>
  );
}

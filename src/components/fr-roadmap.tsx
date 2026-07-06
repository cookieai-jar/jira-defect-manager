"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AtSign, CalendarClock, ChevronRight, ExternalLink, RefreshCw, ShieldAlert } from "lucide-react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusChip } from "@/components/jira-chips";
import { monthKeyOf } from "@/lib/fr-roadmap";
import { cn } from "@/lib/utils";
import type { CommittedRoadmap, CommittedMonth, RoadmapFr, RoadmapChild, RoadmapDependency } from "@/types/triage";

/** Month key offset from now (handles year wrap), e.g. -1 = previous month. */
function shiftedMonthKey(now: number, delta: number): string {
  const d = new Date(now);
  return monthKeyOf(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, 1));
}

export function FrRoadmap() {
  const [roadmap, setRoadmap] = useState<CommittedRoadmap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [openFrs, setOpenFrs] = useState<Set<string>>(new Set());
  const [openMonths, setOpenMonths] = useState<Set<string> | null>(null);
  const [showOther, setShowOther] = useState(false);

  // The near window — previous / current / next month — shown as primary rows.
  const { currentKey, nearKeys } = useMemo(() => {
    const now = Date.now();
    return {
      currentKey: shiftedMonthKey(now, 0),
      nearKeys: new Set([shiftedMonthKey(now, -1), shiftedMonthKey(now, 0), shiftedMonthKey(now, 1)]),
    };
  }, []);

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
      // Default: expand the current month only (prev/next visible but collapsed).
      setOpenMonths(new Set([currentKey]));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load roadmap");
    } finally {
      setLoading(false);
    }
  }, [currentKey]);

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
  /** Bulk open/close a set of FR rows (used by a month's "expand all"). */
  const setFrsOpen = (keys: string[], open: boolean) =>
    setOpenFrs((s) => {
      const next = new Set(s);
      for (const k of keys) (open ? next.add(k) : next.delete(k));
      return next;
    });

  const totals = roadmap
    ? roadmap.months.reduce(
        (acc, m) => ({
          frs: acc.frs + m.frCount,
          blockers: acc.blockers + m.blockerCount,
          incomplete: acc.incomplete + m.incompleteChildCount,
        }),
        { frs: 0, blockers: 0, incomplete: 0 },
      )
    : { frs: 0, blockers: 0, incomplete: 0 };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2">
            <CalendarClock className="h-4 w-4 text-accent" /> Committed roadmap
          </CardTitle>
          <span className="text-[11px] text-fg-subtle">
            Integrations FRs by targeted month
            {roadmap && roadmap.months.length > 0 && (
              <>
                {" "}· {totals.frs} committed across {roadmap.months.length} months
                {totals.blockers > 0 && <span className="text-danger"> · {totals.blockers} blockers</span>}
                {totals.incomplete > 0 && (
                  <span className="text-warning"> · {totals.incomplete} epics missing fields</span>
                )}
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
          <p className="text-sm text-fg-muted">No Integrations FRs have a Targeted Month set.</p>
        ) : (
          <>
            {(() => {
              const near = roadmap.months.filter((m) => nearKeys.has(m.key));
              const other = roadmap.months.filter((m) => !nearKeys.has(m.key));
              const renderMonth = (m: CommittedMonth) => (
                <MonthGroup
                  key={m.key}
                  month={m}
                  open={openMonths?.has(m.key) ?? false}
                  onToggle={() => toggleMonth(m.key)}
                  openFrs={openFrs}
                  onToggleFr={toggleFr}
                  onSetFrsOpen={setFrsOpen}
                />
              );
              return (
                <>
                  {near.map(renderMonth)}
                  {other.length > 0 && (
                    <div className="rounded border border-border">
                      <button
                        type="button"
                        onClick={() => setShowOther((v) => !v)}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-fg-muted hover:bg-bg-muted/40 transition-colors"
                      >
                        <ChevronRight className={cn("h-4 w-4 transition-transform", showOther && "rotate-90")} />
                        <span className="font-medium">Other months</span>
                        <span className="ml-auto text-[11px] text-fg-subtle">
                          {other.length} month{other.length === 1 ? "" : "s"} ·{" "}
                          {other.reduce((n, m) => n + m.frCount, 0)} FRs
                        </span>
                      </button>
                      {showOther && (
                        <div className="space-y-2 border-t border-border/60 p-2">{other.map(renderMonth)}</div>
                      )}
                    </div>
                  )}
                </>
              );
            })()}
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
  onSetFrsOpen,
}: {
  month: CommittedMonth;
  open: boolean;
  onToggle: () => void;
  openFrs: Set<string>;
  onToggleFr: (key: string) => void;
  onSetFrsOpen: (keys: string[], open: boolean) => void;
}) {
  const frKeys = month.frs.map((f) => f.key);
  const allFrsOpen = frKeys.length > 0 && frKeys.every((k) => openFrs.has(k));
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
          {month.incompleteChildCount > 0 && (
            <span
              className="rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 font-mono text-warning"
              title={`${month.incompleteChildCount} epic(s) missing planning fields`}
            >
              {month.incompleteChildCount} incomplete
            </span>
          )}
          {month.blockerCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded border border-danger/40 bg-danger/10 px-1.5 py-0.5 font-mono text-danger">
              <ShieldAlert className="h-3 w-3" />
              {month.blockerCount}
            </span>
          )}
        </span>
      </button>
      {open && (
        <div className="border-t border-border/60">
          <div className="flex justify-end px-3 py-1">
            <button
              type="button"
              onClick={() => onSetFrsOpen(frKeys, !allFrsOpen)}
              className="text-[11px] text-fg-subtle hover:text-accent transition-colors"
            >
              {allFrsOpen ? "Collapse all FRs" : "Expand all FRs"}
            </button>
          </div>
          <div className="divide-y divide-border/60 border-t border-border/60">
            {month.frs.map((fr) => (
              <FrRow key={fr.key} fr={fr} open={openFrs.has(fr.key)} onToggle={() => onToggleFr(fr.key)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function FrRow({ fr, open, onToggle }: { fr: RoadmapFr; open: boolean; onToggle: () => void }) {
  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-bg-muted/20"
      >
        <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-fg-subtle transition-transform", open && "rotate-90")} />
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
          {fr.incompleteChildCount > 0 && (
            <span
              className="rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[10px] font-mono text-warning"
              title={`${fr.incompleteChildCount} epic(s) missing planning fields`}
            >
              {fr.incompleteChildCount} incomplete
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
                <EacChildRow key={c.key} child={c} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function daysAgoLabel(iso: string): string {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  return d <= 0 ? "today" : d === 1 ? "1 day ago" : `${d} days ago`;
}

function EacChildRow({ child: c }: { child: RoadmapChild }) {
  const [ping, setPing] = useState<{ state: "idle" | "busy" | "done" | "error"; msg?: string }>({ state: "idle" });
  const [bumped, setBumped] = useState(false); // optimistically count this session's ping

  const pingCount = c.pingCount + (bumped ? 1 : 0);
  const lastPingedAt = bumped ? new Date().toISOString() : c.lastPingedAt;

  const doPing = async () => {
    const who = c.assignee ? c.assignee.displayName : "this unassigned epic";
    if (
      !window.confirm(
        `Post a comment on ${c.key} pinging ${who} to add: ${c.missingFields.join(", ")}?\n\nThis notifies them in JIRA.`,
      )
    )
      return;
    setPing({ state: "busy" });
    try {
      const res = (await fetch("/api/fr/roadmap/ping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueKey: c.key }),
      }).then((r) => r.json())) as { ok: boolean; posted?: boolean; message?: string; error?: string };
      if (res.ok && res.posted) {
        setBumped(true);
        setPing({ state: "done", msg: `Pinged ${c.assignee?.displayName ?? "assignee"}` });
      } else if (res.ok) setPing({ state: "done", msg: res.message ?? "Nothing to ping" });
      else setPing({ state: "error", msg: res.error ?? "Failed" });
    } catch (e) {
      setPing({ state: "error", msg: e instanceof Error ? e.message : "Failed" });
    }
  };

  return (
    <div className="rounded border border-border bg-bg-card px-2.5 py-1.5">
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
        <span className="ml-auto flex items-center gap-2 shrink-0">
          {c.assignee && <span className="text-[10px] text-fg-subtle">{c.assignee.displayName}</span>}
          <StatusChip status={c.status} />
        </span>
      </div>
      {c.missingFields.length > 0 ? (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <span className="text-[10px] text-fg-subtle">missing:</span>
          {c.missingFields.map((f) => (
            <span
              key={f}
              className="rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning"
            >
              {f}
            </span>
          ))}
          {ping.state === "done" ? (
            <span className="ml-1 text-[10px] text-success">✓ {ping.msg}</span>
          ) : ping.state === "error" ? (
            <span className="ml-1 text-[10px] text-danger" title={ping.msg}>
              ⚠ {ping.msg}
            </span>
          ) : (
            <button
              type="button"
              onClick={doPing}
              disabled={ping.state === "busy"}
              title={`Comment on ${c.key} pinging the assignee to fill these fields`}
              className="ml-1 inline-flex items-center gap-1 rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent hover:bg-accent/20 transition-colors disabled:opacity-60"
            >
              <AtSign className="h-3 w-3" />
              {ping.state === "busy" ? "Pinging…" : c.assignee ? `Ping ${c.assignee.displayName}` : "Comment"}
            </button>
          )}
          {pingCount > 0 && lastPingedAt && (
            <span
              className="ml-1 text-[10px] text-fg-subtle"
              title={`Last pinged ${new Date(lastPingedAt).toLocaleString()}`}
            >
              pinged {pingCount}× · {daysAgoLabel(lastPingedAt)}
            </span>
          )}
        </div>
      ) : (
        <div className="mt-1 text-[10px] text-success">✓ Due date, estimate &amp; sprint set</div>
      )}
      {c.dependencies.length > 0 && (
        <div className="mt-1.5 pl-1">
          <DependencyList deps={c.dependencies} label={null} />
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

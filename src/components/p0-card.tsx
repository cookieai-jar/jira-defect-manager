"use client";

import { useState, useMemo } from "react";
import { Card, CardBody } from "@/components/ui/card";
import { HealthBadge } from "@/components/ui/badge";
import { Markdown } from "@/components/markdown";
import { PriorityChip, StatusChip } from "@/components/jira-chips";
import { cn, formatDate } from "@/lib/utils";
import { priorityFromString } from "@/lib/priority";
import type { P0Summary, ResolvedTicketRef } from "@/types/triage";
import { ChevronDown, ExternalLink } from "lucide-react";

type Tab = "weekly" | "daily" | "plan" | "resolved";

function priorityRank(p: string | null | undefined): number {
  const canonical = priorityFromString(p);
  if (canonical === "P0") return 0;
  if (canonical === "P1") return 1;
  if (canonical === "P2") return 2;
  if (canonical === "P3") return 3;
  return 999;
}

export function P0Card({
  summary,
  defaultOpen = false,
  jiraBaseUrl,
}: {
  summary: P0Summary;
  defaultOpen?: boolean;
  jiraBaseUrl?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [tab, setTab] = useState<Tab>("weekly");
  const resolvedTickets = summary.resolvedTickets ?? [];
  const body =
    tab === "weekly"
      ? summary.weeklyProgress
      : tab === "daily"
        ? summary.dailyTracker
        : tab === "plan"
          ? summary.resolutionPlan
          : "";
  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "w-full px-4 py-3 flex items-center justify-between gap-3 text-left transition-colors",
          open ? "border-b border-border bg-bg-muted/40" : "hover:bg-bg-muted/40",
        )}
        aria-expanded={open}
      >
        <div className="flex items-center gap-2 min-w-0">
          <ChevronDown
            className={cn(
              "h-4 w-4 text-fg-muted transition-transform shrink-0",
              open ? "rotate-0" : "-rotate-90",
            )}
          />
          <span className="text-warning text-base leading-none">★</span>
          <h3 className="text-sm font-semibold truncate">{summary.customer}</h3>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[11px] text-fg-subtle">
            <span className="text-fg-muted">{summary.openIssueKeys.length}</span> open
            <span className="mx-1.5 text-fg-subtle">·</span>
            <span className="text-fg-muted">{resolvedTickets.length}</span> resolved
          </span>
          <HealthBadge health={summary.health} />
        </div>
      </button>

      {open && (
        <>
          <div className="flex gap-1 border-b border-border px-4 bg-bg-card overflow-x-auto scroll-thin">
            {(
              [
                ["weekly", "Weekly progress"],
                ["daily", "Daily tracker"],
                ["plan", "Resolution plan"],
                ["resolved", `Resolved tickets${resolvedTickets.length ? ` (${resolvedTickets.length})` : ""}`],
              ] as [Tab, string][]
            ).map(([t, label]) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  "px-3 py-2 text-xs font-medium transition-colors -mb-[1px] border-b-2 whitespace-nowrap",
                  tab === t
                    ? "border-accent text-fg"
                    : "border-transparent text-fg-muted hover:text-fg",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <CardBody className="space-y-3">
            {tab === "resolved" ? (
              <ResolvedTicketsList tickets={resolvedTickets} jiraBaseUrl={jiraBaseUrl} />
            ) : (
              <Markdown jiraBaseUrl={jiraBaseUrl}>{body}</Markdown>
            )}
            {summary.blockers.length > 0 && tab !== "weekly" && tab !== "resolved" && (
              <div className="border-t border-border pt-3">
                <div className="text-[11px] uppercase tracking-wide text-fg-subtle mb-1">
                  Blockers
                </div>
                <ul className="text-xs text-fg-muted list-disc pl-4 space-y-0.5">
                  {summary.blockers.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
              </div>
            )}
          </CardBody>
        </>
      )}
    </Card>
  );
}

function ResolvedTicketsList({
  tickets,
  jiraBaseUrl,
}: {
  tickets: ResolvedTicketRef[];
  jiraBaseUrl?: string;
}) {
  const sorted = useMemo(() => {
    return [...tickets].sort((a, b) => {
      const pr = priorityRank(a.priority) - priorityRank(b.priority);
      if (pr !== 0) return pr;
      // Tiebreaker: most recently resolved first
      const ad = a.resolved ? new Date(a.resolved).getTime() : 0;
      const bd = b.resolved ? new Date(b.resolved).getTime() : 0;
      return bd - ad;
    });
  }, [tickets]);

  if (sorted.length === 0) {
    return (
      <p className="text-sm text-fg-muted py-2">
        No tickets resolved for this customer in the past 90 days.
      </p>
    );
  }
  return (
    <ul className="divide-y divide-border -mx-2">
      {sorted.map((t) => {
        const href = t.url || (jiraBaseUrl ? `${jiraBaseUrl}/browse/${t.key}` : undefined);
        const canonical = priorityFromString(t.priority);
        return (
          <li key={t.key} className="px-2 py-2">
            <div className="flex items-baseline justify-between gap-2">
              <div className="flex items-baseline gap-2 min-w-0 flex-wrap">
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-xs text-accent hover:text-accent-hover hover:underline shrink-0"
                  >
                    {t.key}
                    <ExternalLink className="inline-block h-3 w-3 ml-0.5 -translate-y-px" />
                  </a>
                ) : (
                  <span className="font-mono text-xs text-accent">{t.key}</span>
                )}
                {canonical && <PriorityChip priority={canonical} />}
                {t.status && <StatusChip status={t.status} />}
                <span className="text-sm text-fg-muted truncate">{t.summary}</span>
              </div>
              {t.resolved && (
                <span className="text-[11px] text-fg-subtle font-mono whitespace-nowrap shrink-0">
                  {formatDate(t.resolved)}
                </span>
              )}
            </div>
            {t.assignee && (
              <div className="text-[10px] text-fg-subtle mt-0.5">
                Resolved by{" "}
                <span className="text-fg-muted">{t.assignee}</span>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

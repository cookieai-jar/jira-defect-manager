"use client";

import { useState } from "react";
import { Card, CardBody } from "@/components/ui/card";
import { HealthBadge } from "@/components/ui/badge";
import { Markdown } from "@/components/markdown";
import { cn } from "@/lib/utils";
import type { P0Summary } from "@/types/triage";
import { ChevronDown } from "lucide-react";

type Tab = "weekly" | "daily" | "plan";

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
  const body =
    tab === "weekly" ? summary.weeklyProgress : tab === "daily" ? summary.dailyTracker : summary.resolutionPlan;
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
            {summary.openIssueKeys.length} ticket{summary.openIssueKeys.length === 1 ? "" : "s"}
          </span>
          <HealthBadge health={summary.health} />
        </div>
      </button>

      {open && (
        <>
          <div className="flex gap-1 border-b border-border px-4 bg-bg-card">
            {(["weekly", "daily", "plan"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  "px-3 py-2 text-xs font-medium capitalize transition-colors -mb-[1px] border-b-2",
                  tab === t
                    ? "border-accent text-fg"
                    : "border-transparent text-fg-muted hover:text-fg",
                )}
              >
                {t === "weekly"
                  ? "Weekly progress"
                  : t === "daily"
                    ? "Daily tracker"
                    : "Resolution plan"}
              </button>
            ))}
          </div>
          <CardBody className="space-y-3">
            <Markdown jiraBaseUrl={jiraBaseUrl}>{body}</Markdown>
            {summary.blockers.length > 0 && tab !== "weekly" && (
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

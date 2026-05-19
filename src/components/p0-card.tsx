"use client";

import { useState } from "react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { HealthBadge } from "@/components/ui/badge";
import { Markdown } from "@/components/markdown";
import { cn } from "@/lib/utils";
import type { P0Summary } from "@/types/triage";

type Tab = "weekly" | "daily" | "plan";

export function P0Card({ summary }: { summary: P0Summary }) {
  const [tab, setTab] = useState<Tab>("weekly");
  const body =
    tab === "weekly" ? summary.weeklyProgress : tab === "daily" ? summary.dailyTracker : summary.resolutionPlan;
  return (
    <Card>
      <CardHeader className="flex-col items-stretch !block">
        <div className="flex items-center justify-between gap-3 mb-2">
          <CardTitle className="flex items-center gap-2">
            <span className="text-warning text-base leading-none">★</span>
            {summary.customer}
          </CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-fg-subtle">
              {summary.openIssueKeys.length} open
            </span>
            <HealthBadge health={summary.health} />
          </div>
        </div>
        <div className="flex gap-1 border-b border-border -mb-3 -mx-4 px-4">
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
              {t === "weekly" ? "Weekly progress" : t === "daily" ? "Daily tracker" : "Resolution plan"}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardBody className="space-y-3">
        <Markdown>{body}</Markdown>
        {summary.blockers.length > 0 && tab !== "weekly" && (
          <div className="border-t border-border pt-3">
            <div className="text-[11px] uppercase tracking-wide text-fg-subtle mb-1">Blockers</div>
            <ul className="text-xs text-fg-muted list-disc pl-4 space-y-0.5">
              {summary.blockers.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

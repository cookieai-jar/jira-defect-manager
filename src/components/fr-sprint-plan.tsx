"use client";

import { useMemo } from "react";
import { GitBranch, Clock, CalendarRange } from "lucide-react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { TempBadge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  sprintPlan,
  epicOrphans,
  inFlightAging,
  type DeliveryRow,
} from "@/lib/fr-delivery";
import type { JiraIssue, TicketAnalysis } from "@/types/triage";

interface Row extends TicketAnalysis {
  issue: JiraIssue;
}

const COLUMN_MAX = 6;
const CALLOUT_MAX = 5;

export function FrSprintPlan({
  rows,
  onSelect,
}: {
  rows: Row[];
  onSelect?: (key: string) => void;
}) {
  const buckets = useMemo(() => sprintPlan(rows as DeliveryRow[]), [rows]);
  const orphans = useMemo(() => epicOrphans(rows as DeliveryRow[]), [rows]);
  const aging = useMemo(() => inFlightAging(rows as DeliveryRow[]), [rows]);

  const openCount = buckets.reduce((n, b) => n + b.count, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarRange className="h-4 w-4 text-accent" />
          Sprint plan
        </CardTitle>
        <span className="text-[11px] text-fg-subtle">
          {openCount} open FR{openCount === 1 ? "" : "s"} across two sprints + backlog
        </span>
      </CardHeader>
      <CardBody className="space-y-4">
        {openCount === 0 ? (
          <p className="text-center text-fg-muted text-sm py-6">
            No open FRs to plan.
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {buckets.map((bucket) => (
              <div
                key={bucket.key}
                className="rounded border border-border bg-bg-muted/40"
              >
                <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                  <span className="text-xs font-semibold text-fg">{bucket.label}</span>
                  <span className="font-mono text-xs text-fg-muted">{bucket.count}</span>
                </div>
                <ul className="divide-y divide-border/50">
                  {bucket.rows.slice(0, COLUMN_MAX).map((r) => (
                    <li key={r.issueKey}>
                      <button
                        type="button"
                        onClick={() => onSelect?.(r.issueKey)}
                        className="w-full text-left px-3 py-1.5 hover:bg-bg-muted/80 transition-colors flex items-center gap-2"
                      >
                        <span className="font-mono text-[11px] text-accent shrink-0">
                          {r.issueKey}
                        </span>
                        <span className="text-xs text-fg-muted truncate flex-1">
                          {r.issue.summary}
                        </span>
                        <span className="shrink-0">
                          <TempBadge band={r.temperature} score={r.temperatureScore} />
                        </span>
                      </button>
                    </li>
                  ))}
                  {bucket.count === 0 && (
                    <li className="px-3 py-3 text-center text-[11px] text-fg-subtle">
                      Empty
                    </li>
                  )}
                </ul>
                {bucket.count > COLUMN_MAX && (
                  <div className="px-3 py-1.5 text-[11px] text-fg-subtle border-t border-border/50">
                    +{bucket.count - COLUMN_MAX} more
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {(orphans.count > 0 || aging.length > 0) && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {orphans.count > 0 && (
              <Callout
                icon={<GitBranch className="h-3.5 w-3.5" />}
                tone="warning"
                title="Not attached to an epic"
                count={orphans.count}
                hint="Unplanned FRs that need an epic"
              >
                {orphans.rows.slice(0, CALLOUT_MAX).map((r) => (
                  <CalloutChip
                    key={r.issueKey}
                    issueKey={r.issueKey}
                    onSelect={onSelect}
                  />
                ))}
                {orphans.count > CALLOUT_MAX && (
                  <span className="text-[11px] text-fg-subtle">
                    +{orphans.count - CALLOUT_MAX}
                  </span>
                )}
              </Callout>
            )}
            {aging.length > 0 && (
              <Callout
                icon={<Clock className="h-3.5 w-3.5" />}
                tone="danger"
                title="In-flight going quiet"
                count={aging.length}
                hint="Active/blocked FRs with no update in 14+ days"
              >
                {aging.slice(0, CALLOUT_MAX).map(({ row, daysQuiet }) => (
                  <CalloutChip
                    key={row.issueKey}
                    issueKey={row.issueKey}
                    suffix={`${daysQuiet}d quiet`}
                    onSelect={onSelect}
                  />
                ))}
                {aging.length > CALLOUT_MAX && (
                  <span className="text-[11px] text-fg-subtle">
                    +{aging.length - CALLOUT_MAX}
                  </span>
                )}
              </Callout>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function Callout({
  icon,
  tone,
  title,
  count,
  hint,
  children,
}: {
  icon: React.ReactNode;
  tone: "warning" | "danger";
  title: string;
  count: number;
  hint: string;
  children: React.ReactNode;
}) {
  const toneCls = tone === "danger" ? "text-danger" : "text-warning";
  return (
    <div className="rounded border border-border bg-bg-muted/40 px-3 py-2.5 space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-semibold">
        <span className={toneCls}>{icon}</span>
        <span className="text-fg">{title}</span>
        <span className={cn("font-mono", toneCls)}>{count}</span>
      </div>
      <p className="text-[11px] text-fg-subtle">{hint}</p>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

function CalloutChip({
  issueKey,
  suffix,
  onSelect,
}: {
  issueKey: string;
  suffix?: string;
  onSelect?: (key: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect?.(issueKey)}
      className="inline-flex items-center gap-1 rounded border border-border bg-bg-card px-1.5 py-0.5 hover:border-accent/50 transition-colors"
    >
      <span className="font-mono text-[11px] text-accent">{issueKey}</span>
      {suffix && <span className="text-[10px] text-fg-subtle">{suffix}</span>}
    </button>
  );
}

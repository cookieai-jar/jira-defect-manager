"use client";

import { useMemo, useState } from "react";
import { Users, GitBranch, ChevronDown } from "lucide-react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  ownershipLoad,
  blockedItems,
  UNASSIGNED,
  type Row,
} from "@/lib/fr-team-load";

export function FrTeamLoad({
  rows,
  onSelect,
}: {
  rows: Row[];
  onSelect?: (key: string) => void;
}) {
  void onSelect; // assignee bars are not individually clickable
  const load = useMemo(() => ownershipLoad(rows), [rows]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <Users className="h-3.5 w-3.5 text-fg-muted" />
          Team load
        </CardTitle>
        <span className="text-[11px] text-fg-subtle">
          {load.total} open across {load.entries.length} owners
        </span>
      </CardHeader>
      <CardBody className="space-y-2">
        {load.entries.length === 0 ? (
          <p className="text-center text-fg-muted text-sm py-4">No open FRs.</p>
        ) : (
          load.entries.map((e) => {
            const pct = load.max > 0 ? (e.count / load.max) * 100 : 0;
            const unassigned = e.assignee === UNASSIGNED;
            return (
              <div key={e.assignee} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span
                    className={cn(
                      "truncate",
                      unassigned ? "text-warning font-medium" : "text-fg",
                    )}
                  >
                    {e.assignee}
                  </span>
                  <span className="font-mono text-fg-muted ml-2 shrink-0">
                    {e.count}
                  </span>
                </div>
                <div className="h-1.5 w-full rounded bg-bg-muted overflow-hidden">
                  <div
                    className={cn(
                      "h-full rounded",
                      unassigned ? "bg-warning" : "bg-accent",
                    )}
                    style={{ width: `${Math.max(pct, 2)}%` }}
                  />
                </div>
              </div>
            );
          })
        )}
      </CardBody>
    </Card>
  );
}

/** How many blocked FRs to show before the "Show all" toggle. */
const BLOCKED_COLLAPSED = 6;

export function FrBlocked({
  rows,
  onSelect,
}: {
  rows: Row[];
  onSelect?: (key: string) => void;
}) {
  const blocked = useMemo(() => blockedItems(rows), [rows]);
  const [expanded, setExpanded] = useState(false);

  const collapsible = blocked.length > BLOCKED_COLLAPSED;
  const visible = expanded || !collapsible ? blocked : blocked.slice(0, BLOCKED_COLLAPSED);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <GitBranch className="h-3.5 w-3.5 text-fg-muted" />
          Blocked FRs
        </CardTitle>
        <span className="text-[11px] text-fg-subtle">{blocked.length} blocked</span>
      </CardHeader>
      <CardBody className="space-y-2">
        {blocked.length === 0 ? (
          <p className="text-center text-fg-muted text-sm py-4">No blocked FRs.</p>
        ) : (
          <>
            {visible.map((b) => (
              <button
                key={b.key}
                type="button"
                onClick={onSelect ? () => onSelect(b.key) : undefined}
                disabled={!onSelect}
                className={cn(
                  "w-full text-left rounded border border-border bg-bg-muted/40 px-2.5 py-2",
                  onSelect && "cursor-pointer hover:bg-bg-muted/70",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs text-accent shrink-0">
                    {b.key}
                  </span>
                  <span className="text-[10px] font-mono text-warning shrink-0">
                    {b.ageDays}d blocked
                  </span>
                </div>
                <div className="mt-0.5 text-xs text-fg font-medium truncate">
                  {b.summary}
                </div>
                <div className="mt-0.5 text-[11px] text-fg-muted line-clamp-2">
                  {b.reason}
                </div>
              </button>
            ))}
            {collapsible && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                className="w-full flex items-center justify-center gap-1 rounded border border-border bg-bg-muted/40 py-1.5 text-[11px] font-medium text-fg-muted hover:text-fg hover:bg-bg-muted/70 transition-colors"
              >
                <ChevronDown
                  className={cn("h-3 w-3 transition-transform", expanded && "rotate-180")}
                />
                {expanded ? "Show fewer" : `Show all ${blocked.length}`}
              </button>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}

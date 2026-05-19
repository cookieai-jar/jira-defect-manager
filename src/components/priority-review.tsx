"use client";

import { useMemo } from "react";
import {
  ArrowUpCircle,
  ArrowDownCircle,
  Clock,
  CheckCircle2,
  AlertTriangle,
  EyeOff,
  Bell,
  X,
  RotateCcw,
} from "lucide-react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn, daysSince, formatDate } from "@/lib/utils";
import type {
  JiraIssue,
  Priority,
  PriorityDecision,
  TicketAnalysis,
} from "@/types/triage";

interface Row extends TicketAnalysis {
  issue: JiraIssue;
}

const PRIORITY_STYLES: Record<Priority, string> = {
  P0: "border-danger/50 bg-danger/10 text-danger",
  P1: "border-warning/50 bg-warning/10 text-warning",
  P2: "border-accent/50 bg-accent/10 text-accent",
  P3: "border-success/50 bg-success/10 text-success",
};

interface Props {
  rows: Row[];
  decisions: PriorityDecision[];
  onSelect: (key: string) => void;
  onDecisionsChanged: () => void | Promise<void>;
}

export function PriorityReview({ rows, decisions, onSelect, onDecisionsChanged }: Props) {
  const decisionMap = useMemo(
    () => new Map(decisions.map((d) => [d.issueKey, d])),
    [decisions],
  );

  const {
    active,
    revisit,
    ignored,
    late,
    atRisk,
    onTrack,
    onTrackByPriority,
    totals,
  } = useMemo(() => {
    const allAdjustments = rows.filter(
      (r) => r.priorityChange === "raise" || r.priorityChange === "lower",
    );
    // Also surface ignored rows even if their current priorityChange is now
    // "keep" (which means the ignore worked / aligned).
    const allDecided = rows.filter((r) => decisionMap.has(r.issueKey));
    const seen = new Set<string>();
    const merged: Row[] = [];
    for (const r of [...allAdjustments, ...allDecided]) {
      if (!seen.has(r.issueKey)) {
        seen.add(r.issueKey);
        merged.push(r);
      }
    }
    const active: Row[] = [];
    const revisit: Row[] = [];
    const ignored: Row[] = [];
    for (const r of merged) {
      const d = decisionMap.get(r.issueKey);
      if (!d) {
        if (r.priorityChange === "raise" || r.priorityChange === "lower") {
          active.push(r);
        }
        continue;
      }
      if (d.revisitFlagged) revisit.push(r);
      else ignored.push(r);
    }
    const sortByPriority = (a: Row, b: Row) => {
      const order: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
      if (a.priorityChange !== b.priorityChange) {
        if (a.priorityChange === "raise") return -1;
        if (b.priorityChange === "raise") return 1;
      }
      return (
        (order[a.currentPriority as Priority] ?? 99) -
        (order[b.currentPriority as Priority] ?? 99)
      );
    };
    active.sort(sortByPriority);
    revisit.sort(sortByPriority);
    ignored.sort(sortByPriority);

    const late = rows
      .filter((r) => r.slaStatus === "late")
      .sort((a, b) => slaDaysOver(b) - slaDaysOver(a));
    const atRisk = rows
      .filter((r) => r.slaStatus === "at-risk")
      .sort((a, b) => slaDaysOver(b) - slaDaysOver(a));
    const onTrack = rows.filter((r) => r.slaStatus === "on-track");
    const onTrackByPriority: Record<Priority, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
    for (const r of onTrack) {
      if (r.currentPriority) onTrackByPriority[r.currentPriority]++;
    }
    const totals = {
      active: active.length,
      revisit: revisit.length,
      ignored: ignored.length,
      late: late.length,
      atRisk: atRisk.length,
      onTrack: onTrack.length,
    };
    return { active, revisit, ignored, late, atRisk, onTrack, onTrackByPriority, totals };
  }, [rows, decisionMap]);

  async function ignoreRow(r: Row) {
    await fetch("/api/priority-decisions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        issueKey: r.issueKey,
        decision: "ignore",
        decidedPriorityChange: r.priorityChange ?? null,
        decidedRecommendedPriority: r.recommendedPriority ?? null,
        decidedCurrentPriority: r.currentPriority ?? null,
      }),
    });
    await onDecisionsChanged();
  }

  async function unignore(issueKey: string) {
    await fetch(`/api/priority-decisions/${issueKey}`, { method: "DELETE" });
    await onDecisionsChanged();
  }

  async function dismissRevisit(issueKey: string) {
    await fetch(`/api/priority-decisions/${issueKey}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "dismiss-revisit" }),
    });
    await onDecisionsChanged();
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">Priority &amp; SLA review</h2>
        <span className="text-xs text-fg-muted">
          Per-ticket recommendations against the{" "}
          <a href="/definitions" className="text-accent underline">
            priority definitions
          </a>
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
        <PriorityAdjustmentsTile
          active={active}
          revisit={revisit}
          ignored={ignored}
          totals={totals}
          decisionMap={decisionMap}
          onSelect={onSelect}
          onIgnore={ignoreRow}
          onUnignore={unignore}
          onDismissRevisit={dismissRevisit}
        />

        <Tile
          title="Late on SLA"
          icon={<Clock className="h-4 w-4 text-danger" />}
          count={totals.late}
          tone="danger"
          empty="Nothing past its SLA window."
        >
          {late.map((r) => (
            <SlaRow key={r.issueKey} row={r} tone="danger" onSelect={onSelect} />
          ))}
        </Tile>

        <Tile
          title="At-risk on SLA"
          icon={<Clock className="h-4 w-4 text-warning" />}
          count={totals.atRisk}
          tone="warning"
          empty="Nothing currently in the SLA risk window."
        >
          {atRisk.map((r) => (
            <SlaRow key={r.issueKey} row={r} tone="warning" onSelect={onSelect} />
          ))}
        </Tile>

        <Tile
          title="On-track"
          icon={<CheckCircle2 className="h-4 w-4 text-success" />}
          count={totals.onTrack}
          tone="success"
          empty="No tickets currently within SLA."
        >
          <div className="space-y-2 text-sm">
            <div className="text-xs text-fg-muted">By current priority:</div>
            <div className="flex flex-wrap gap-2">
              {(["P0", "P1", "P2", "P3"] as Priority[]).map((p) => (
                <Badge key={p} className={cn("border", PRIORITY_STYLES[p])}>
                  <span className="font-mono">{p}</span>
                  <span className="ml-1.5 font-mono">{onTrackByPriority[p]}</span>
                </Badge>
              ))}
            </div>
            {onTrack.length > 0 && (
              <div className="pt-2 border-t border-border space-y-1 max-h-40 overflow-auto scroll-thin">
                {onTrack.slice(0, 20).map((r) => (
                  <OnTrackRow key={r.issueKey} row={r} onSelect={onSelect} />
                ))}
                {onTrack.length > 20 && (
                  <p className="text-[11px] text-fg-subtle pt-1">
                    +{onTrack.length - 20} more on track
                  </p>
                )}
              </div>
            )}
          </div>
        </Tile>
      </div>
    </section>
  );
}

function PriorityAdjustmentsTile({
  active,
  revisit,
  ignored,
  totals,
  decisionMap,
  onSelect,
  onIgnore,
  onUnignore,
  onDismissRevisit,
}: {
  active: Row[];
  revisit: Row[];
  ignored: Row[];
  totals: { active: number; revisit: number; ignored: number };
  decisionMap: Map<string, PriorityDecision>;
  onSelect: (k: string) => void;
  onIgnore: (r: Row) => Promise<void>;
  onUnignore: (k: string) => Promise<void>;
  onDismissRevisit: (k: string) => Promise<void>;
}) {
  const totalRows = revisit.length + active.length + ignored.length;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-accent" /> Priority adjustments
        </CardTitle>
        <div className="flex items-center gap-1.5">
          {totals.revisit > 0 && (
            <Badge className="border-danger/40 bg-danger/10 text-danger border">
              <Bell className="h-3 w-3" />
              {totals.revisit} re-evaluate
            </Badge>
          )}
          <Badge>{totals.active} active</Badge>
          {totals.ignored > 0 && (
            <Badge className="border-fg-subtle/40 bg-fg-subtle/10 text-fg-muted border">
              {totals.ignored} ignored
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardBody className="max-h-80 overflow-auto scroll-thin space-y-3">
        {/* Revisit (most urgent) */}
        {revisit.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-danger">
              <Bell className="h-3 w-3" /> Re-evaluate
            </div>
            <ul className="space-y-2">
              {revisit.map((r) => (
                <AdjustmentRow
                  key={r.issueKey}
                  row={r}
                  decision={decisionMap.get(r.issueKey)}
                  state="revisit"
                  onSelect={onSelect}
                  onIgnore={onIgnore}
                  onUnignore={onUnignore}
                  onDismissRevisit={onDismissRevisit}
                />
              ))}
            </ul>
          </div>
        )}

        {/* Active */}
        {active.length > 0 && (
          <div className="space-y-2">
            {revisit.length > 0 && (
              <div className="text-[11px] uppercase tracking-wide text-fg-subtle">
                Active
              </div>
            )}
            <ul className="space-y-2">
              {active.map((r) => (
                <AdjustmentRow
                  key={r.issueKey}
                  row={r}
                  state="active"
                  onSelect={onSelect}
                  onIgnore={onIgnore}
                  onUnignore={onUnignore}
                  onDismissRevisit={onDismissRevisit}
                />
              ))}
            </ul>
          </div>
        )}

        {/* Ignored — always visible inline so users can find and untoggle them */}
        {ignored.length > 0 && (
          <div
            className={cn(
              "space-y-2",
              (revisit.length > 0 || active.length > 0) && "border-t border-border pt-3",
            )}
          >
            <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-fg-subtle">
              <EyeOff className="h-3 w-3" /> Ignored
            </div>
            <ul className="space-y-2">
              {ignored.map((r) => (
                <AdjustmentRow
                  key={r.issueKey}
                  row={r}
                  decision={decisionMap.get(r.issueKey)}
                  state="ignored"
                  onSelect={onSelect}
                  onIgnore={onIgnore}
                  onUnignore={onUnignore}
                  onDismissRevisit={onDismissRevisit}
                />
              ))}
            </ul>
          </div>
        )}

        {totalRows === 0 && (
          <p className="text-fg-muted text-sm py-2">No priority changes recommended.</p>
        )}
      </CardBody>
    </Card>
  );
}

function AdjustmentRow({
  row,
  decision,
  state,
  onSelect,
  onIgnore,
  onUnignore,
  onDismissRevisit,
}: {
  row: Row;
  decision?: PriorityDecision;
  state: "active" | "revisit" | "ignored";
  onSelect: (k: string) => void;
  onIgnore: (r: Row) => Promise<void>;
  onUnignore: (k: string) => Promise<void>;
  onDismissRevisit: (k: string) => Promise<void>;
}) {
  const raise = row.priorityChange === "raise";
  const lower = row.priorityChange === "lower";
  const containerCls = cn(
    "rounded px-2 py-1.5 -mx-2",
    state === "revisit"
      ? "bg-danger/5 border border-danger/30"
      : state === "ignored"
        ? "bg-bg-muted/30 opacity-75 hover:opacity-100 hover:bg-bg-muted/60"
        : "hover:bg-bg-muted/60",
  );
  return (
    <li className={containerCls}>
      <div className="flex items-start gap-2">
        <div
          onClick={() => onSelect(row.issueKey)}
          className="flex-1 min-w-0 cursor-pointer"
        >
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-xs text-accent">{row.issueKey}</span>
            {row.currentPriority && (
              <Badge className={cn("border", PRIORITY_STYLES[row.currentPriority])}>
                {row.currentPriority}
              </Badge>
            )}
            {(raise || lower) && row.recommendedPriority && (
              <>
                {raise ? (
                  <ArrowUpCircle className="h-3.5 w-3.5 text-danger" />
                ) : (
                  <ArrowDownCircle className="h-3.5 w-3.5 text-success" />
                )}
                <Badge className={cn("border", PRIORITY_STYLES[row.recommendedPriority])}>
                  {row.recommendedPriority}
                </Badge>
              </>
            )}
            {row.priorityChange === "keep" && state === "ignored" && (
              <Badge className="border-fg-subtle/40 bg-fg-subtle/10 text-fg-muted border">
                aligned
              </Badge>
            )}
          </div>
          <div className="mt-1 text-xs text-fg-muted truncate">{row.issue.summary}</div>
          {row.priorityRationale && (
            <p className="mt-0.5 text-[11px] text-fg-subtle line-clamp-2">
              {row.priorityRationale}
            </p>
          )}
          {state === "revisit" && decision?.revisitReason && (
            <p className="mt-1 text-[11px] text-danger">
              <span className="font-medium">Why revisit:</span> {decision.revisitReason}
            </p>
          )}
          {state === "ignored" && decision && (
            <p className="mt-0.5 text-[10px] text-fg-subtle">
              Ignored {formatDate(decision.decidedAt)}
              {decision.decidedRecommendedPriority &&
                ` · was ${decision.decidedPriorityChange} to ${decision.decidedRecommendedPriority}`}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1 shrink-0">
          {state === "active" && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onIgnore(row)}
              aria-label="Mark as ignored"
              title="Mark this recommendation as ignored. The ticket stays visible below."
            >
              <EyeOff className="h-3 w-3" />
              Ignore
            </Button>
          )}
          {state === "revisit" && (
            <>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => onDismissRevisit(row.issueKey)}
                aria-label="Dismiss revisit and keep ignored"
                title="Keep the existing ignore and dismiss the re-evaluate flag."
              >
                <X className="h-3 w-3" />
                Keep ignored
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onUnignore(row.issueKey)}
                aria-label="Unignore"
                title="Clear the ignore and bring this recommendation back to active."
              >
                <RotateCcw className="h-3 w-3" />
                Unignore
              </Button>
            </>
          )}
          {state === "ignored" && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onUnignore(row.issueKey)}
              aria-label="Unignore"
              title="Clear the ignore and bring this recommendation back to active."
            >
              <RotateCcw className="h-3 w-3" />
              Unignore
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}

function Tile({
  title,
  icon,
  count,
  tone,
  empty,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  count: number;
  tone: "danger" | "warning" | "success" | "accent";
  empty: string;
  children: React.ReactNode;
}) {
  const toneCls =
    tone === "danger"
      ? "border-danger/40 bg-danger/10 text-danger"
      : tone === "warning"
        ? "border-warning/40 bg-warning/10 text-warning"
        : tone === "success"
          ? "border-success/40 bg-success/10 text-success"
          : "border-accent/40 bg-accent/10 text-accent";
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {icon} {title}
        </CardTitle>
        <Badge className={cn("border", toneCls)}>{count}</Badge>
      </CardHeader>
      <CardBody className="max-h-80 overflow-auto scroll-thin">
        {count === 0 ? (
          <p className="text-fg-muted text-sm py-2">{empty}</p>
        ) : (
          <ul className="space-y-2.5">{children}</ul>
        )}
      </CardBody>
    </Card>
  );
}

function SlaRow({
  row,
  tone,
  onSelect,
}: {
  row: Row;
  tone: "danger" | "warning";
  onSelect: (k: string) => void;
}) {
  const over = slaDaysOver(row);
  const overLabel =
    tone === "danger"
      ? `${over}d late`
      : row.slaTargetDate
        ? `${Math.max(0, Math.ceil(-over))}d remaining`
        : "—";
  const overCls = tone === "danger" ? "text-danger" : "text-warning";
  return (
    <li
      onClick={() => onSelect(row.issueKey)}
      className="cursor-pointer rounded -mx-2 px-2 py-1.5 hover:bg-bg-muted/60"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono text-xs text-accent">{row.issueKey}</span>
        {row.currentPriority && (
          <Badge className={cn("border", PRIORITY_STYLES[row.currentPriority])}>
            {row.currentPriority}
          </Badge>
        )}
        <span className={cn("font-mono text-[11px] font-semibold", overCls)}>{overLabel}</span>
        {row.slaTargetDate && (
          <span className="text-[11px] text-fg-subtle font-mono">
            target {formatDate(row.slaTargetDate)}
          </span>
        )}
      </div>
      <div className="mt-1 text-xs text-fg-muted truncate">{row.issue.summary}</div>
      {row.nextStep && (
        <div className="mt-0.5 text-[11px] text-fg">
          <span className="text-fg-subtle">Next: </span>
          {row.nextStep}
        </div>
      )}
      <div className="mt-0.5 text-[10px] text-fg-subtle">
        Assignee: <span className="text-fg-muted">{row.issue.assignee ?? "unassigned"}</span>
        {" · "}
        Age: <span className="text-fg-muted font-mono">{daysSince(row.issue.created)}d</span>
      </div>
    </li>
  );
}

function OnTrackRow({ row, onSelect }: { row: Row; onSelect: (k: string) => void }) {
  return (
    <li
      onClick={() => onSelect(row.issueKey)}
      className="cursor-pointer flex items-baseline gap-2 rounded -mx-1 px-1 py-0.5 hover:bg-bg-muted/60"
    >
      <span className="font-mono text-xs text-accent">{row.issueKey}</span>
      {row.currentPriority && (
        <span
          className={cn(
            "font-mono text-[10px] font-semibold",
            row.currentPriority === "P0"
              ? "text-danger"
              : row.currentPriority === "P1"
                ? "text-warning"
                : row.currentPriority === "P2"
                  ? "text-accent"
                  : "text-success",
          )}
        >
          {row.currentPriority}
        </span>
      )}
      <span className="text-xs text-fg-muted truncate">{row.issue.summary}</span>
    </li>
  );
}

function slaDaysOver(r: Row): number {
  if (!r.slaTargetDate) return 0;
  const target = new Date(r.slaTargetDate);
  if (isNaN(target.getTime())) return 0;
  return Math.floor((Date.now() - target.getTime()) / (1000 * 60 * 60 * 24));
}

"use client";

import { useMemo } from "react";
import { Layers, Users, ClipboardCheck, Copy, Star } from "lucide-react";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { JiraIssue, TicketAnalysis } from "@/types/triage";
import {
  themeClusters,
  customerConcentration,
  triageCoverage,
  possibleDuplicates,
} from "@/lib/fr-demand";

interface Row extends TicketAnalysis {
  issue: JiraIssue;
}

export function FrDemandInsights({
  rows,
  onSelect,
}: {
  rows: Row[];
  onSelect?: (key: string) => void;
}) {
  const themeData = useMemo(() => themeClusters(rows), [rows]);
  const customers = useMemo(() => customerConcentration(rows), [rows]);
  const coverage = useMemo(() => triageCoverage(rows), [rows]);
  const dupes = useMemo(() => possibleDuplicates(rows), [rows]);

  const clickable = Boolean(onSelect);
  const select = (key: string) => onSelect?.(key);

  const uncatShare =
    themeData.openTotal === 0
      ? 0
      : themeData.uncategorizedCount / themeData.openTotal;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
      {/* Themes */}
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-accent" /> Demand themes
          </CardTitle>
          <span className="text-[11px] text-fg-subtle">
            {themeData.themes.length}{" "}
            {themeData.themes.length === 1 ? "theme" : "themes"} ·{" "}
            {themeData.openTotal} open FRs
          </span>
        </CardHeader>
        <CardBody className="p-0">
          {themeData.themes.length === 0 ? (
            <Empty>No open FRs to cluster.</Empty>
          ) : (
            <>
              <p className="px-4 pt-2 text-[11px] text-fg-subtle">
                Tags are component + label. A FR can appear under multiple themes,
                so counts sum to more than {themeData.openTotal}.
              </p>
              {uncatShare > 0.2 && (
                <p className="mx-4 mt-2 rounded border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[11px] text-warning">
                  {Math.round(uncatShare * 100)}% of open FRs ({themeData.uncategorizedCount}){" "}
                  carry no component or label — demand can&apos;t be read until they&apos;re tagged.
                </p>
              )}
              <div className="overflow-x-auto scroll-thin">
                <table className="w-full text-sm">
                  <thead className="text-[11px] uppercase tracking-wide text-fg-subtle">
                    <tr className="border-b border-border">
                      <th className="px-4 py-2 text-left font-medium">Theme</th>
                      <th className="px-3 py-2 text-right font-medium">FRs</th>
                      <th className="px-3 py-2 text-right font-medium">Share</th>
                      <th className="px-3 py-2 text-right font-medium">Avg demand</th>
                      <th className="px-3 py-2 text-right font-medium">Avg value</th>
                      <th className="px-3 py-2 text-left font-medium">Tickets</th>
                    </tr>
                  </thead>
                  <tbody>
                    {themeData.themes.map((t) => (
                      <tr
                        key={t.theme}
                        className={cn(
                          "border-b border-border/50 align-top",
                          t.tooGeneric && "opacity-60",
                        )}
                      >
                        <td className="px-4 py-2 max-w-[280px]">
                          <div className="flex items-center gap-1.5">
                            <span className="text-fg font-medium truncate">{t.theme}</span>
                            {t.tooGeneric && (
                              <span
                                className="shrink-0 rounded border border-border-strong bg-bg-muted px-1 py-px text-[9px] uppercase tracking-wide text-fg-subtle"
                                title="Buckets >40% of open FRs — too broad to act on"
                              >
                                catch-all
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-fg">{t.count}</td>
                        <td className="px-3 py-2 text-right font-mono text-fg-muted text-xs">
                          {Math.round(t.share * 100)}%
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Score value={t.avgDemand} />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Score value={t.avgValue} />
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            {t.keys.slice(0, 6).map((k) => (
                              <KeyChip key={k} k={k} clickable={clickable} onClick={() => select(k)} />
                            ))}
                            {t.keys.length > 6 && (
                              <span className="text-[11px] text-fg-subtle self-center">
                                +{t.keys.length - 6}
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardBody>
      </Card>

      {/* Top customer demand */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-4 w-4 text-accent" /> Top customer demand
          </CardTitle>
          <span className="text-[11px] text-fg-subtle">
            {customers.distinctCustomers} distinct
          </span>
        </CardHeader>
        <CardBody className="p-0">
          {customers.entries.length === 0 ? (
            <Empty>No customer attributed to any open FR.</Empty>
          ) : (
            <ul className="divide-y divide-border/50">
              {customers.entries.slice(0, 8).map((c) => (
                <li
                  key={c.customer}
                  className="flex items-center gap-2 px-4 py-2 text-sm"
                >
                  {c.isWhiteGlove ? (
                    <Star
                      className="h-3.5 w-3.5 text-warning shrink-0"
                      fill="currentColor"
                      aria-label="White-glove customer"
                    />
                  ) : (
                    <span className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  )}
                  <span className="text-fg truncate flex-1">{c.customer}</span>
                  <span className="font-mono text-fg-muted">{c.count}</span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {/* Triage coverage */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ClipboardCheck className="h-4 w-4 text-accent" /> Triage coverage
          </CardTitle>
          <span className="text-[11px] text-fg-subtle">{coverage.total} open FRs</span>
        </CardHeader>
        <CardBody className="space-y-3">
          <div className="flex items-end gap-2">
            <div
              className={cn(
                "text-3xl font-semibold leading-none",
                coverage.coveragePct >= 80
                  ? "text-success"
                  : coverage.coveragePct >= 50
                    ? "text-warning"
                    : "text-danger",
              )}
            >
              {coverage.coveragePct}%
            </div>
            <div className="text-[11px] text-fg-subtle pb-0.5">have an owner</div>
          </div>
          <div className="h-2 w-full rounded overflow-hidden bg-bg-muted border border-border">
            <div
              className={cn(
                "h-full",
                coverage.coveragePct >= 80
                  ? "bg-success"
                  : coverage.coveragePct >= 50
                    ? "bg-warning"
                    : "bg-danger",
              )}
              style={{ width: `${coverage.coveragePct}%` }}
            />
          </div>
          <p className="text-xs text-fg-muted">
            <span className="text-fg font-medium">{coverage.untriaged}</span> untriaged
            {coverage.untriaged > 0 && " — no human owner"}
          </p>
          {coverage.untriaged > 0 && (
            <div className="flex flex-wrap gap-1">
              {coverage.untriagedRows.slice(0, 12).map((r) => (
                <KeyChip
                  key={r.issueKey}
                  k={r.issueKey}
                  clickable={clickable}
                  onClick={() => select(r.issueKey)}
                />
              ))}
              {coverage.untriagedRows.length > 12 && (
                <span className="text-[11px] text-fg-subtle self-center">
                  +{coverage.untriagedRows.length - 12}
                </span>
              )}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Possible duplicates — only when any */}
      {dupes.length > 0 && (
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Copy className="h-4 w-4 text-warning" /> Possible duplicates
            </CardTitle>
            <span className="text-[11px] text-fg-subtle">
              {dupes.length} {dupes.length === 1 ? "cluster" : "clusters"} · heuristic, verify
            </span>
          </CardHeader>
          <CardBody className="space-y-2">
            {dupes.map((d) => (
              <div
                key={d.keys.join("-")}
                className="flex items-start gap-2 text-sm border-b border-border/40 last:border-0 pb-2 last:pb-0"
              >
                <div className="flex flex-wrap gap-1 shrink-0">
                  {d.keys.map((k) => (
                    <KeyChip key={k} k={k} clickable={clickable} onClick={() => select(k)} />
                  ))}
                </div>
                <span className="text-fg-muted truncate">{d.sampleSummary}</span>
              </div>
            ))}
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function Score({ value }: { value: number }) {
  return (
    <span
      className={cn(
        "font-mono text-xs",
        value >= 7 ? "text-danger" : value >= 5 ? "text-warning" : "text-fg-muted",
      )}
    >
      {value.toFixed(1)}
    </span>
  );
}

function KeyChip({
  k,
  clickable,
  onClick,
}: {
  k: string;
  clickable: boolean;
  onClick: () => void;
}) {
  const base =
    "inline-flex items-center rounded border border-border bg-bg-muted px-1.5 py-px font-mono text-[10px] text-accent";
  if (!clickable) return <span className={base}>{k}</span>;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(base, "hover:border-accent/50 hover:bg-accent/10 transition-colors")}
    >
      {k}
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 py-6 text-center text-sm text-fg-muted">{children}</div>
  );
}

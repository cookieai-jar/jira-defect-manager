"use client";

import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { TrendChart } from "@/components/trend-chart";
import { cn } from "@/lib/utils";
import { flowSummary, type Row } from "@/lib/fr-flow";
import type { TrendBucket } from "@/types/triage";

const VERDICT_LABEL: Record<"growing" | "shrinking" | "steady", string> = {
  growing: "Backlog growing",
  shrinking: "Backlog shrinking",
  steady: "Backlog steady",
};

const VERDICT_TONE: Record<"growing" | "shrinking" | "steady", string> = {
  growing: "text-warning",
  shrinking: "text-success",
  steady: "text-fg-muted",
};

export function FrFlowTrend({
  trend,
  rows,
}: {
  trend: TrendBucket[] | undefined;
  rows: Row[];
}) {
  const flow = flowSummary(trend, rows);

  return (
    <Card>
      <CardHeader>
        <CardTitle>FR flow</CardTitle>
        <div className="flex items-center gap-3 text-[11px]">
          <span className={cn("font-medium", VERDICT_TONE[flow.verdict])}>
            {VERDICT_LABEL[flow.verdict]}
            {flow.hasTrend && (
              <span className="ml-1 font-mono">
                ({flow.net > 0 ? `+${flow.net}` : flow.net})
              </span>
            )}
          </span>
          <span className="text-fg-subtle">
            WIP <span className="font-mono text-fg">{flow.wip}</span>
          </span>
        </div>
      </CardHeader>
      <CardBody>
        {flow.hasTrend ? (
          <TrendChart data={trend ?? []} />
        ) : (
          <div className="py-6 text-center text-sm text-fg-muted">
            No trend yet — run a sync.
          </div>
        )}
      </CardBody>
    </Card>
  );
}

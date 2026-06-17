"use client";

import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { TempBadge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  buildMatrix,
  QUADRANT_ORDER,
  type Quadrant,
  type Row,
} from "@/lib/fr-prioritization";

const CELL_TONE: Record<Quadrant, string> = {
  "build-now": "border-danger/40 bg-danger/5",
  "nice-to-have": "border-warning/40 bg-warning/5",
  "strategic-bet": "border-accent/40 bg-accent/5",
  deprioritize: "border-border bg-bg-muted/30",
};

const CELL_HINT: Record<Quadrant, string> = {
  "build-now": "High demand · high value",
  "nice-to-have": "High demand · low value",
  "strategic-bet": "Low demand · high value",
  deprioritize: "Low demand · low value",
};

const TOP_N = 5;

export function FrDemandValueMatrix({
  rows,
  onSelect,
}: {
  rows: Row[];
  onSelect?: (key: string) => void;
}) {
  const { cells, total } = buildMatrix(rows);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Prioritization matrix</CardTitle>
        <span className="text-[11px] text-fg-subtle">
          Demand × Value · {total} open FR{total === 1 ? "" : "s"}
        </span>
      </CardHeader>
      <CardBody>
        {total === 0 ? (
          <div className="py-6 text-center text-sm text-fg-muted">
            No open FRs to plot.
          </div>
        ) : (
          <div className="flex gap-2">
            {/* Y axis label */}
            <div className="flex items-center justify-center">
              <span className="text-[10px] uppercase tracking-wide text-fg-subtle -rotate-90 whitespace-nowrap">
                Demand →
              </span>
            </div>
            <div className="flex-1 space-y-2">
              <div className="grid grid-cols-2 gap-2">
                {QUADRANT_ORDER.map((q) => {
                  const cell = cells[q];
                  const top = cell.rows.slice(0, TOP_N);
                  const more = cell.rows.length - top.length;
                  return (
                    <div
                      key={q}
                      className={cn(
                        "rounded border p-2.5 min-h-[120px] flex flex-col",
                        CELL_TONE[q],
                      )}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-sm font-semibold text-fg">
                          {cell.label}
                        </span>
                        <span className="font-mono text-sm text-fg-muted">
                          {cell.rows.length}
                        </span>
                      </div>
                      <div className="text-[10px] text-fg-subtle mb-1.5">
                        {CELL_HINT[q]}
                      </div>
                      <ul className="space-y-1 flex-1">
                        {top.map((r) => (
                          <li key={r.issueKey} className="flex items-center gap-1.5">
                            <button
                              onClick={() => onSelect?.(r.issueKey)}
                              className="font-mono text-[11px] text-accent hover:underline shrink-0"
                            >
                              {r.issueKey}
                            </button>
                            <span className="text-[11px] text-fg-muted truncate flex-1">
                              {r.issue.summary}
                            </span>
                            <TempBadge band={r.temperature} score={r.temperatureScore} />
                          </li>
                        ))}
                        {cell.rows.length === 0 && (
                          <li className="text-[11px] text-fg-subtle">—</li>
                        )}
                      </ul>
                      {more > 0 && (
                        <div className="mt-1 text-[10px] text-fg-subtle">
                          +{more} more
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {/* X axis label */}
              <div className="text-center text-[10px] uppercase tracking-wide text-fg-subtle">
                Value →
              </div>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

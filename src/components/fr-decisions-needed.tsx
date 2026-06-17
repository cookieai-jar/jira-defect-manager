"use client";

import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { decisionsNeeded, type FrAction, type Row } from "@/lib/fr-flow";

const ACTION_TONE: Record<FrAction, string> = {
  promote: "border-accent/40 bg-accent/10 text-accent border",
  schedule: "border-accent/40 bg-accent/10 text-accent border",
  unblock: "border-warning/40 bg-warning/10 text-warning border",
  "needs-spec": "border-warning/40 bg-warning/10 text-warning border",
  decline: "border-danger/40 bg-danger/10 text-danger border",
  review: "border-border-strong bg-bg-muted text-fg-muted",
};

const ACTION_LABEL: Record<FrAction, string> = {
  promote: "promote",
  schedule: "schedule",
  unblock: "unblock",
  "needs-spec": "needs spec",
  decline: "decline",
  review: "review",
};

export function FrDecisionsNeeded({
  rows,
  onSelect,
}: {
  rows: Row[];
  onSelect?: (key: string) => void;
}) {
  const items = decisionsNeeded(rows);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Decisions needed</CardTitle>
        {items.length > 0 && (
          <span className="text-[11px] text-fg-subtle">{items.length} ranked</span>
        )}
      </CardHeader>
      <CardBody className="p-0">
        {items.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-fg-muted">
            Nothing needs a decision right now.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((d) => (
              <li
                key={d.issueKey}
                className="px-4 py-2.5 hover:bg-bg-muted/60"
              >
                <div className="flex items-center gap-2">
                  <Badge className={cn("shrink-0", ACTION_TONE[d.action])}>
                    {ACTION_LABEL[d.action]}
                  </Badge>
                  <button
                    onClick={() => onSelect?.(d.issueKey)}
                    className="font-mono text-xs text-accent hover:underline shrink-0"
                  >
                    {d.issueKey}
                  </button>
                  <span className="text-sm text-fg truncate">{d.summary}</span>
                </div>
                {d.nextStep && (
                  <p className="mt-0.5 pl-1 text-[11px] text-fg-muted truncate">
                    {d.nextStep}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

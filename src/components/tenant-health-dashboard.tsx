"use client";

import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  HeartPulse,
  CheckCircle2,
  PlugZap,
  Database,
  MessageSquare,
  Ticket,
  SlidersHorizontal,
} from "lucide-react";

/**
 * Per-tenant Integrations Health dashboard.
 *
 * Phase 0 scaffold: the data pipeline (Grafana metrics + Slack alerts + the
 * JIRA Customer join) is being wired incrementally. This screen mirrors the
 * other dashboards' chrome and reports exactly what is connected vs. pending,
 * so it is useful as a status surface until the sync lands in Phase 1.
 */
export function TenantHealthDashboard() {
  return (
    <div className="flex-1 overflow-auto scroll-thin">
      <header className="px-6 h-14 border-b border-border flex items-center justify-between sticky top-0 z-10 bg-bg/90 backdrop-blur">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <HeartPulse className="h-4 w-4 text-accent" />
            Tenant Health
          </h1>
          <Badge className="border-accent/40 bg-accent/10 text-accent border">
            Phase 0
          </Badge>
        </div>
      </header>

      <div className="p-6 space-y-6 max-w-3xl">
        <Card>
          <CardHeader>
            <CardTitle>Data sources</CardTitle>
            <span className="text-[11px] text-fg-subtle">wiring status</span>
          </CardHeader>
          <CardBody className="space-y-2.5">
            <SourceRow
              icon={<Ticket className="h-4 w-4" />}
              name="JIRA — Customer join"
              status="ready"
              detail="Verified: customfield_10044 (multi-select) → tenant name. Captured on every synced issue."
            />
            <SourceRow
              icon={<SlidersHorizontal className="h-4 w-4" />}
              name="Threshold engine"
              status="ready"
              detail="Tunable SLA rules (e.g. extraction > 24h → critical). Defaults shipped; per-tenant overrides supported."
            />
            <SourceRow
              icon={<Database className="h-4 w-4" />}
              name="Grafana / Prometheus"
              status="needs-keys"
              detail="Client ready. Set GRAFANA_URL, GRAFANA_TOKEN (and optional GRAFANA_PROM_DATASOURCE_UID), then run the metric-discovery spike."
            />
            <SourceRow
              icon={<MessageSquare className="h-4 w-4" />}
              name="Slack — alerts"
              status="needs-keys"
              detail="Client ready. Set SLACK_BOT_TOKEN and SLACK_ALERT_CHANNEL_IDS, then run the channel-sample spike."
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <PlugZap className="h-4 w-4 text-warning" /> Next: connect Grafana &amp; Slack
            </CardTitle>
          </CardHeader>
          <CardBody className="space-y-3 text-sm text-fg-muted">
            <p>
              Once the keys above are in <code className="text-fg">.env.local</code>, run the
              Phase&nbsp;0 discovery spikes to capture the real metric names, label keys, and alert
              format:
            </p>
            <pre className="rounded border border-border bg-bg-muted/50 px-3 py-2 text-[12px] text-fg overflow-x-auto">
{`node --env-file=.env.local scripts/phase0/spike-grafana.mjs
node --env-file=.env.local scripts/phase0/spike-slack.mjs`}
            </pre>
            <p>
              Phase&nbsp;1 then lights up this page: a tenant picker, per-integration cards
              (extraction/parse time with SLA flags, node/edge/entity counts), error groups,
              alerts, linked JIRA tickets, incidents, and trends.
            </p>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function SourceRow({
  icon,
  name,
  status,
  detail,
}: {
  icon: React.ReactNode;
  name: string;
  status: "ready" | "needs-keys";
  detail: string;
}) {
  const ready = status === "ready";
  return (
    <div className="flex items-start gap-3 rounded border border-border bg-bg-muted/30 px-3 py-2.5">
      <span className={ready ? "text-success mt-0.5" : "text-fg-muted mt-0.5"}>{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-fg">{name}</span>
          {ready ? (
            <Badge className="border-success/40 bg-success/10 text-success border">
              <CheckCircle2 className="h-3 w-3" /> ready
            </Badge>
          ) : (
            <Badge className="border-warning/40 bg-warning/10 text-warning border">
              needs keys
            </Badge>
          )}
        </div>
        <p className="mt-0.5 text-[12px] text-fg-muted">{detail}</p>
      </div>
    </div>
  );
}

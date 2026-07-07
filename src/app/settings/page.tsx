"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Check, CircleAlert, Loader2, Save } from "lucide-react";
import type { AppConfig } from "@/types/triage";
import { SCOPES, SCOPE_LABELS } from "@/types/triage";
import { Toggle } from "@/components/ui/toggle";

interface Health {
  jira: { ok: true; user: string } | { ok: false; error: string };
  anthropic: { ok: true } | { ok: false; error: string };
  env: { jiraBaseUrl: string | null; jiraEmail: string | null; model: string };
}

export default function SettingsPage() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then(setConfig);
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth);
  }, []);

  async function save() {
    if (!config) return;
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const next = await res.json();
      setConfig(next);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      // Notify other client components (nav) that config has changed.
      window.dispatchEvent(new Event("app-config-changed"));
    } finally {
      setSaving(false);
    }
  }

  if (!config) {
    return (
      <div className="p-6 flex items-center gap-2 text-fg-muted text-sm">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto scroll-thin">
      <header className="px-6 h-14 border-b border-border flex items-center justify-between">
        <h1 className="text-lg font-semibold">Settings</h1>
        <Button onClick={save} disabled={saving}>
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : saved ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          {saving ? "Saving…" : saved ? "Saved" : "Save"}
        </Button>
      </header>
      <div className="p-6 max-w-3xl space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Connection</CardTitle>
            <span className="text-[11px] text-fg-subtle">From .env.local</span>
          </CardHeader>
          <CardBody className="space-y-3 text-sm">
            <Row label="JIRA base URL" value={health?.env.jiraBaseUrl ?? "—"} />
            <Row label="JIRA user" value={health?.env.jiraEmail ?? "—"} />
            <Row label="Anthropic model (env)" value={health?.env.model ?? "—"} />
            <div className="flex gap-2 pt-2">
              <StatusPill
                label="JIRA"
                ok={health?.jira.ok ?? false}
                detail={
                  health?.jira.ok
                    ? `as ${health.jira.user}`
                    : health?.jira && !health.jira.ok
                      ? health.jira.error
                      : "checking…"
                }
              />
              <StatusPill
                label="Anthropic"
                ok={health?.anthropic.ok ?? false}
                detail={
                  health?.anthropic.ok
                    ? "key present"
                    : health?.anthropic && !health.anthropic.ok
                      ? health.anthropic.error
                      : "checking…"
                }
              />
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Dashboard visibility</CardTitle>
            <span className="text-[11px] text-fg-subtle">
              Hide dashboards from the sidebar without deleting their data
            </span>
          </CardHeader>
          <CardBody className="divide-y divide-border">
            {SCOPES.map((s) => (
              <Toggle
                key={s}
                checked={config.dashboards[s]}
                onChange={(next) =>
                  setConfig({
                    ...config,
                    dashboards: { ...config.dashboards, [s]: next },
                  })
                }
                label={`Show ${SCOPE_LABELS[s]} Dashboard`}
                description={
                  s === "eac"
                    ? "Customer support / bug triage view."
                    : s === "fr"
                      ? "Feature request triage view."
                      : "Security vulnerability and PII triage view."
                }
              />
            ))}
            <Toggle
              checked={config.siDashboard}
              onChange={(next) => setConfig({ ...config, siDashboard: next })}
              label="Show Integrations Hardening"
              description="Cross-ticket pattern analysis of integration defects: issue categories, root causes, and developer/QE hardening steps."
            />
          </CardBody>
        </Card>

        {SCOPES.map((s) => (
          <Card key={s}>
            <CardHeader>
              <CardTitle>{SCOPE_LABELS[s]} triage scope</CardTitle>
              <span className="text-[11px] text-fg-subtle">
                Defines the universe of {SCOPE_LABELS[s]} tickets to triage
              </span>
            </CardHeader>
            <CardBody className="space-y-3">
              <div className="space-y-1.5">
                <Label>{SCOPE_LABELS[s]} master JQL</Label>
                <Textarea
                  value={config.jqls[s]}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      jqls: { ...config.jqls, [s]: e.target.value },
                    })
                  }
                  placeholder={`project = ${SCOPE_LABELS[s]} AND statusCategory != Done ORDER BY updated DESC`}
                />
                <p className="text-[11px] text-fg-subtle">
                  {SCOPE_LABELS[s]} white-glove customer JQL fragments will be AND&apos;d against this filter.
                </p>
              </div>
            </CardBody>
          </Card>
        ))}

        <Card>
          <CardHeader>
            <CardTitle>Integrations Hardening scope</CardTitle>
            <span className="text-[11px] text-fg-subtle">
              Tickets pulled for the deep pattern analysis
            </span>
          </CardHeader>
          <CardBody className="space-y-3">
            <div className="space-y-1.5">
              <Label>Integrations Hardening JQL</Label>
              <Textarea
                value={config.siJql}
                onChange={(e) => setConfig({ ...config, siJql: e.target.value })}
                placeholder="project = INTEG AND issuetype in (Bug, Defect) AND labels = strategic-integration ORDER BY created DESC"
              />
              <p className="text-[11px] text-fg-subtle">
                Every ticket matched here is run through the deep analysis to surface recurring issue
                categories, root causes, and developer/QE hardening steps.
              </p>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Analysis settings</CardTitle>
            <span className="text-[11px] text-fg-subtle">Shared across all scopes</span>
          </CardHeader>
          <CardBody className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Field
                label="Sprint length (days)"
                value={config.sprintLengthDays}
                onChange={(n) => setConfig({ ...config, sprintLengthDays: n })}
              />
              <Field
                label="Inactivity → close (days)"
                value={config.inactivityThresholdDays}
                onChange={(n) => setConfig({ ...config, inactivityThresholdDays: n })}
              />
              <Field
                label="Ping threshold (days)"
                value={config.pingThresholdDays}
                onChange={(n) => setConfig({ ...config, pingThresholdDays: n })}
              />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Anthropic model</Label>
                <Input
                  value={config.model}
                  onChange={(e) => setConfig({ ...config, model: e.target.value })}
                />
              </div>
              <Field
                label="Max issues per sync"
                value={config.maxIssuesPerSync}
                onChange={(n) => setConfig({ ...config, maxIssuesPerSync: n })}
              />
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-fg-muted">{label}</span>
      <span className="font-mono text-xs text-fg truncate max-w-[60%]">{value}</span>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input
        type="number"
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isNaN(n)) onChange(n);
        }}
      />
    </div>
  );
}

function StatusPill({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <Badge
      className={
        ok
          ? "border-success/40 bg-success/10 text-success"
          : "border-danger/40 bg-danger/10 text-danger"
      }
    >
      {ok ? <Check className="h-3 w-3" /> : <CircleAlert className="h-3 w-3" />}
      {label} · {detail}
    </Badge>
  );
}

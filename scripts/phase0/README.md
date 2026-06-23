# Phase 0 — Tenant Health Dashboard de-risking

Goal: replace the three external-data unknowns with real, verified shapes before
building the Phase 1 ingestion pipeline.

## Run

```bash
# JIRA spike runs now (creds already in .env.local):
node --env-file=.env.local scripts/phase0/spike-jira-customer-field.mjs

# These need keys added to .env.local first (see below):
node --env-file=.env.local scripts/phase0/spike-grafana.mjs
node --env-file=.env.local scripts/phase0/spike-slack.mjs
```

## Findings

### 1. JIRA ⇄ tenant join — RESOLVED ✅ (verified against live JIRA)
- Field: **`customfield_10044`**, name `"Customer"`, multi-select (`type=array`, `items=option`).
- Serializes as an array of `{ self, value, id }`; we keep `.value` (the tenant name).
- Live samples: `["Prudential Financial"]`, `["BCG"]`, `["Luminor Group"]` across FR/EAC/OPS.
- Decoys to avoid: a textfield also named `"Customer"` (`customfield_11752`), plus
  `"Customer name"`, `"Customer segments"`, etc. Pin the id, not the name.
- Wired: `jira.ts` now requests this field and exposes `JiraIssue.customers: string[]`
  via the tested pure helper `extractCustomers()`.

### 2. Grafana / Prometheus metrics — PENDING KEYS ⛔
Need in `.env.local`:
- `GRAFANA_URL` — base URL
- `GRAFANA_TOKEN` — service-account token (Viewer is enough)
- `GRAFANA_PROM_DATASOURCE_UID` — optional; the spike discovers it via `/api/datasources`

`spike-grafana.mjs` will then: find the Prometheus datasource UID, list metric names,
grep for `extract|parse|node|edge|entit|error`, and print each candidate's label keys.
**Open question it answers:** the real metric names + the tenant/integration label keys.

### 3. Slack alerts — PENDING KEYS ⛔
Need in `.env.local`:
- `SLACK_BOT_TOKEN` — `xoxb-…` with `channels:history`, `groups:history`, `channels:read`
- `SLACK_ALERT_CHANNEL_IDS` — comma-separated channel ids where extraction/parse alerts fire

`spike-slack.mjs` will `auth.test`, then dump recent messages per channel + the
`parseAlert()` result, so we can confirm the real alert format (and whether it's
structured Grafana output or free-form).

### 4. Tenant-name normalization — PARTIAL
JIRA Customer values are human names ("Prudential Financial"). Whether they match
the Grafana tenant label exactly is unknown until the Grafana spike runs. Plan: a
small normalization map (Grafana name → JIRA Customer value(s)) once both are seen.

## What's already built (credential-independent, all tested)
- `src/lib/jira.ts` — Customer field capture (`extractCustomers`, `CUSTOMER_FIELD`).
- `src/types/tenant.ts` — domain model (Tenant, IntegrationMetrics, ThresholdRule/Breach,
  alerts, incidents, TenantHealthReport).
- `src/lib/tenant-thresholds.ts` — tunable SLA engine (24h extraction default, etc.).
- `src/lib/grafana.ts`, `src/lib/slack.ts` — clients (thin I/O) + pure tested parsers.
- `/tenants` route + nav link ("Tenant Health", `tenantDashboard` config flag) with a
  Phase-0 status page using the existing UI.

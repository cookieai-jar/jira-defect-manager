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

### 2. Grafana / Prometheus metrics — RESOLVED ✅ (confirmed live + against cookieai-core source)

**Datasource:** `Production Cluster Metrics`, uid **`DggGZ2cVz`** (pinned in `.env.local`).
198 production tenants present. (`Dev Cluster Metrics` uid=`efpagsg2hfu9sf` has ~36 dev/lab tenants.)

**Confirmed metric names (exist live):**
| Metric | What |
|---|---|
| `veza_platform_extraction_total` | extractions (counter) |
| `veza_platform_extraction_changed_total` | extractions that changed data |
| `veza_platform_extraction_errors_total` | extraction errors |
| `veza_platform_auditlog_extraction_errors_total` | audit-log extraction errors |
| `lcm_processor_extraction_events_{count,errored,long_running,safety_limit,skipped}_total` | LCM extraction-event counters |
| `veza_platform_parser_task_total` | parse tasks (counter) |
| `veza_platform_parser_task_duration_ms_total` | cumulative parse task duration |
| `veza_platform_parser_job_total` / `_job_duration_ms_total` | parse jobs + duration |
| `veza_platform_parser_neo4j_writes_total` | **node/edge counts** (label `entity_type`) |
| `veza_platform_parser_neo4j_io_duration_ms_total` | neo4j io duration |
| `veza_platform_parser_task_change_total` / `_duration_ms_total` | task change (label `has_changes`) |
| `veza_platform_parser_receive_batch_errors_total` | **parse batch errors** |
| `veza_platform_parser_uptime_ms` | parser uptime |

**Labels (confirmed on live series):**
- **`tenant_id`** — the join key. It is a **human-readable slug**, NOT a UUID: `wajax`, `customersbank-prod`, `crb`, `smurfitwestrock`, `radnet`, `odysseyre`, …
- **`agent_type`** — the integration: `active_directory`, `awsbedrock`, `okta`, `aws_*`; compound forms like `active_directory-azure` / `aws_databricks_account-okta` denote CSC pairs.
- **`task`** — `subgraph` | `csc` | `ep` | `enrichment` | `metadata` | `commit`.
- Plus infra labels: `namespace` (e.g. `wajax-cp`), `cluster`, `k8s_cluster_name`, `app=cp-parser-historical`.
- **EP = Effective Permissions, CSC = Cross-Service Connector** (confirmed in source).

### 2b. Grafana / Prometheus metrics — original pending note (superseded)
Need in `.env.local`:
- `GRAFANA_URL` — base URL
- `GRAFANA_TOKEN` — service-account token (Viewer is enough)
- `GRAFANA_PROM_DATASOURCE_UID` — optional; the spike discovers it via `/api/datasources`

`spike-grafana.mjs` will then: find the Prometheus datasource UID, list metric names,
grep for `extract|parse|node|edge|entit|error`, and print each candidate's label keys.
**Open question it answers:** the real metric names + the tenant/integration label keys.

### 3. Alerts — RESOLVED ✅ via Grafana (Slack DROPPED, no token needed)
The extraction/parse alerts originate in Grafana Alerting, so they're reachable with
the existing Grafana token — Slack adds nothing. Confirmed live (`spike-grafana-alerts.mjs`):
- **Active alerts:** `GET /api/alertmanager/grafana/api/v2/alerts` → 241 instances. Real
  extraction/parse alert names: `ParseFailures`, `ExtractionInternalErrors`,
  `AuditLogExtractionFailures`, `PipelineThroughput_ExtractionJobsStuckPending_Tier24/Tier72`,
  `PipelineThroughput_{Legacy,}ParseJobsStuck*`, `PostgreSQLUnknownClassExtractionFailure`,
  `PostgreSQLInternalClassExtractionFailure`.
- **Labels carry the join keys:** `tenant_id`, `namespace` (`<tenant>-cp`), `agent_type`,
  plus `error_reason`, `stage`, `pipeline`, `platform_error`, `severity`, `team`.
- **Known vs unknown is in the alert names** (`...UnknownClass...` vs `...InternalClass...`),
  reinforcing the errclass `user` vs `internal` taxonomy.
- **Rules:** `GET /api/prometheus/grafana/api/v1/rules` → 617 rules (133 extraction/parse/neo4j).
- **History (for trends):** alert-state-history Loki datasource (uid
  `grafanacloud-alert-state-history`), selector `{from="state-history"}`, lines are JSON with
  `current`/`previous` state + full `labels` (incl. `tenant_id`/`namespace`). Gives firing/
  resolved transitions per tenant over time.

Tenant join for alerts: prefer the `tenant_id` label; else derive from `namespace` by
stripping the `-cp` suffix (e.g. `intuit-e2e-cp` → `intuit-e2e`).

Slack `spike-slack.mjs` + `slack.ts` remain in the tree but are unused; revisit only if we
later want human incident chatter that exists nowhere else.

### 4. Tenant-name normalization — CONFIRMED NEEDED ⚠️
Grafana `tenant_id` is a **slug** (`smurfitwestrock`, `customersbank-prod`, `crb`) while
JIRA Customer values are **display names** ("Prudential Financial", "BCG"). They do NOT
match directly. Phase 1 needs a slug→display-name map: fuzzy auto-match (slugify the JIRA
name and compare) plus a manual override table in the in-app tenant registry. Note slugs
can carry env suffixes (`-prod`) and there can be near-dupes (`crb` vs `customersbank-prod`).

### Extraction counts from logs — WIRED ✅ (regional Loki)
- The extractor logs `START - Extracting data source` / `FINISH - Extracting data source`
  per data-source (extractor_worker.go); counting FINISH lines is the truest count of
  actual extractions (more accurate than `veza_platform_extraction_total`).
- **Logs are REGIONAL** (metrics are central): a tenant's data-plane logs live in ONE
  regional Loki (namespace `<tenant>-dp`), e.g. bcgprod → `grafanacloud-vezalondon-logs-eu-west-2`,
  cluster cookie02-prod. NOT `-cp` (that's the control plane). Implementation discovers
  the tenant's region by probing Loki datasources in parallel (cached), then counts via
  `sum by (datasource_type)(count_over_time({namespace="<tenant>-dp"} |= \`FINISH - Extracting data source\` | json [24h]))`.
- Fields on the FINISH line: datasource_type, datasource_id, external_id, provider_id, job_id, trace_id.
- Live bcgprod 24h: START 308,577 / FINISH 308,623 (sharepoint 93k, ms_teams 23k). The
  detail report now uses these as the authoritative extraction counts (sources.loki=true),
  falling back to the metric when a tenant's logs can't be located.

### Error logging (the specific ask) — RESOLVED ✅ (source-confirmed)
- **Extraction errors:** counter `veza_platform_extraction_errors_total`; log detail in **Loki**
  `job="extraction"` with fields `datasource_type`, `provider_id`, `datasource_id`,
  `error_reason`, `pipeline_error=true` (agent_manager → extractor_worker.go).
- **EP/CSC parse errors:** counter `veza_platform_parser_receive_batch_errors_total`; log detail
  in Loki from `cp_parser` with `stage="effective_connect"` (EP) / `stage="csc"`, plus
  `job_id`, `datasource_id`, `agent_type`. Sites: eptask.go, csctask.go, parser_coordinator.go.
- **Known vs unknown:** reuse `agents/pkg/extractor/errclass/audience.go` — `Audience(reason)`
  returns `"user"` (known/actionable) vs `"internal"` (UNKNOWN/INTERNAL → "unknown").
- **Errors/alerts detail lives in Loki**, reachable with the SAME Grafana token (Loki
  datasources: `grafanacloud-caiprod-logs`, per-region veza* logs). `grafana.ts` needs a small
  LogQL query method in Phase 1.

## Phase 1 discovery — tenant `bcgprod` (live, `spike-bcgprod.mjs`)
- Confirmed: tenant_id=`bcgprod`, 249 parser + 61 extraction series. JIRA join: Customer=`"BCG"`.
- **Integration inventory** = distinct `agent_type` on `veza_platform_extraction_total{tenant_id}`
  (~61 real connectors). Parser's 155 agent_types include CSC pairs (`a-b`) — don't use for inventory.
- **Per-integration queries (windowed, 24h):**
  - extractions: `sum by (agent_type)(increase(veza_platform_extraction_total{tenant_id}[24h]))`
  - extraction errors: same on `..._extraction_errors_total`
  - parse time (avg ms/task): `increase(parser_task_duration_ms_total[24h]) / increase(parser_task_total[24h])`
    by agent_type (NOT the all-time ratio — counters skew it; AD/subgraph showed 37M ms all-time).
  - parse throughput: `increase(parser_task_total[24h])` by agent_type.
- **Graph writes (tenant-level, not per-integration):** `increase(parser_neo4j_writes_total[24h])`
  by `entity_type`/`operation` (write volume, NOT absolute graph size — absolute counts aren't in Prometheus).
- **Alerts are the decisive health signal.** bcgprod extraction error *counters* = 0, yet 5 active alerts:
  `PipelineThroughput_ExtractionJobsStuckPending_Tier24` (sharepoint, github_organization) = the 24h SLA
  breach (Grafana computes it — we don't need extraction duration), `ParseFailures` (s3),
  `AuditLogExtractionFailures` (UNKNOWN). Filter Alertmanager by `tenant_id` or `namespace=<tenant>-cp`.
- **Loki error-detail:** `{namespace="bcgprod-cp"}` returned 0 — label/datasource needs a follow-up probe;
  low priority (errors=0; signal is in alerts). Keep behind graceful-empty.

## What's already built (credential-independent, all tested)
- `src/lib/jira.ts` — Customer field capture (`extractCustomers`, `CUSTOMER_FIELD`).
- `src/types/tenant.ts` — domain model (Tenant, IntegrationMetrics, ThresholdRule/Breach,
  alerts, incidents, TenantHealthReport).
- `src/lib/tenant-thresholds.ts` — tunable SLA engine (24h extraction default, etc.).
- `src/lib/grafana.ts`, `src/lib/slack.ts` — clients (thin I/O) + pure tested parsers.
- `/tenants` route + nav link ("Tenant Health", `tenantDashboard` config flag) with a
  Phase-0 status page using the existing UI.

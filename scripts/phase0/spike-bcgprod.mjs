#!/usr/bin/env node
/**
 * Phase 1 discovery: everything available for ONE tenant (default bcgprod), so
 * we design the report queries around real data, not assumptions.
 *
 * Run: node --env-file=.env.local scripts/phase0/spike-bcgprod.mjs [tenant]
 */
const URL = process.env.GRAFANA_URL?.replace(/\/$/, "");
const TOKEN = process.env.GRAFANA_TOKEN;
const DS = process.env.GRAFANA_PROM_DATASOURCE_UID || "DggGZ2cVz";
if (!URL || !TOKEN) {
  console.error("Need GRAFANA_URL and GRAFANA_TOKEN");
  process.exit(1);
}
const TENANT = process.argv[2] || "bcgprod";
const H = { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" };

async function g(path) {
  const res = await fetch(`${URL}${path}`, { headers: H });
  const t = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${t.slice(0, 160)}`);
  return JSON.parse(t);
}
const prom = (q) =>
  g(`/api/datasources/proxy/uid/${DS}/api/v1/query?query=${encodeURIComponent(q)}`);
const promResults = async (q) => (await prom(q)).data?.result ?? [];
const v = (r) => Number(r.value?.[1]);

async function section(title, fn) {
  console.log(`\n==== ${title} ====`);
  try {
    await fn();
  } catch (e) {
    console.log(`  FAILED: ${e.message}`);
  }
}

async function main() {
  console.log(`Tenant: ${TENANT}  (prom ds=${DS})`);

  await section("tenant_id exists? (parser + extraction)", async () => {
    const a = await promResults(`count(veza_platform_parser_task_total{tenant_id="${TENANT}"})`);
    const b = await promResults(`count(veza_platform_extraction_total{tenant_id="${TENANT}"})`);
    console.log(`  parser series=${a.length ? v(a[0]) : 0}  extraction series=${b.length ? v(b[0]) : 0}`);
    if (!a.length && !b.length) {
      const like = await promResults(`count by (tenant_id)({__name__="veza_platform_parser_task_total", tenant_id=~".*${TENANT.slice(0, 3)}.*"})`);
      console.log(`  similar tenant_ids: ${like.map((r) => r.metric.tenant_id).join(", ") || "(none)"}`);
    }
  });

  await section("integrations (agent_type) for this tenant", async () => {
    const r = await promResults(`count by (agent_type) (veza_platform_parser_task_total{tenant_id="${TENANT}"})`);
    console.log(`  ${r.length} agent_types: ${r.map((x) => x.metric.agent_type).sort().join(", ")}`);
  });

  await section("parse: avg ms per task by agent_type+task (duration_total/count_total)", async () => {
    const r = await promResults(
      `sum by (agent_type, task) (veza_platform_parser_task_duration_ms_total{tenant_id="${TENANT}"}) ` +
        `/ sum by (agent_type, task) (veza_platform_parser_task_total{tenant_id="${TENANT}"})`,
    );
    for (const x of r.slice(0, 20)) console.log(`  ${x.metric.agent_type}/${x.metric.task}: ${Math.round(v(x))} ms avg`);
  });

  await section("parse throughput last 24h (increase in task count)", async () => {
    const r = await promResults(`sum by (agent_type) (increase(veza_platform_parser_task_total{tenant_id="${TENANT}"}[24h]))`);
    for (const x of r.slice(0, 20)) console.log(`  ${x.metric.agent_type}: +${Math.round(v(x))} tasks/24h`);
  });

  await section("node/edge writes (neo4j_writes by entity_type, last 24h)", async () => {
    const r = await promResults(
      `sum by (entity_type, operation) (increase(veza_platform_parser_neo4j_writes_total{tenant_id="${TENANT}"}[24h]))`,
    );
    for (const x of r) console.log(`  ${x.metric.entity_type}/${x.metric.operation}: +${Math.round(v(x))}/24h`);
  });

  await section("extraction totals + errors (last 24h increase)", async () => {
    const tot = await promResults(`sum by (agent_type) (increase(veza_platform_extraction_total{tenant_id="${TENANT}"}[24h]))`);
    const err = await promResults(`sum by (agent_type) (increase(veza_platform_extraction_errors_total{tenant_id="${TENANT}"}[24h]))`);
    console.log(`  extractions/24h: ${tot.map((x) => `${x.metric.agent_type}=${Math.round(v(x))}`).join(", ") || "(none)"}`);
    console.log(`  errors/24h:      ${err.map((x) => `${x.metric.agent_type}=${Math.round(v(x))}`).join(", ") || "(none)"}`);
  });

  await section("parse receive-batch errors (last 24h)", async () => {
    const r = await promResults(`sum(increase(veza_platform_parser_receive_batch_errors_total{tenant_id="${TENANT}"}[24h]))`);
    console.log(`  parse batch errors/24h: ${r.length ? Math.round(v(r[0])) : 0}`);
  });

  await section("active alerts for this tenant (Alertmanager)", async () => {
    const all = await g(`/api/alertmanager/grafana/api/v2/alerts`);
    const mine = (Array.isArray(all) ? all : []).filter(
      (a) => a.labels?.tenant_id === TENANT || a.labels?.namespace === `${TENANT}-cp`,
    );
    console.log(`  ${mine.length} active alerts`);
    for (const a of mine.slice(0, 20)) {
      console.log(`  [${a.labels?.severity ?? "?"}] ${a.labels?.alertname}  agent_type=${a.labels?.agent_type ?? "-"} reason=${a.labels?.error_reason ?? a.labels?.stage ?? "-"}`);
    }
  });

  await section("extraction error logs (Loki, last 24h)", async () => {
    const logsUid = "grafanacloud-logs";
    const end = `${Date.now()}000000`;
    const start = `${Date.now() - 24 * 3600 * 1000}000000`;
    // namespace label is <tenant>-cp; job/component varies — probe broadly then show line shape.
    const q = `{namespace="${TENANT}-cp"} |~ "(?i)error" | json | pipeline_error="true"`;
    const path = `/api/datasources/proxy/uid/${logsUid}/loki/api/v1/query_range?query=${encodeURIComponent(q)}&start=${start}&end=${end}&limit=5&direction=backward`;
    let r;
    try {
      r = await g(path);
    } catch (e) {
      console.log(`  pipeline_error query failed (${e.message}); trying plain namespace match`);
      const q2 = `{namespace="${TENANT}-cp"} |~ "(?i)error extracting|parse failed|effective-permission|cross-service"`;
      r = await g(`/api/datasources/proxy/uid/${logsUid}/loki/api/v1/query_range?query=${encodeURIComponent(q2)}&start=${start}&end=${end}&limit=5&direction=backward`);
    }
    const streams = r?.data?.result ?? [];
    console.log(`  ${streams.length} streams`);
    const lines = streams.flatMap((s) => (s.values ?? []).map((x) => x[1])).slice(0, 4);
    for (const l of lines) console.log(`    ${l.slice(0, 220)}`);
    if (streams[0]) console.log(`  stream labels: ${JSON.stringify(streams[0].stream).slice(0, 200)}`);
  });
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

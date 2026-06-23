#!/usr/bin/env node
/**
 * Phase 0 targeted probe: confirm the source-derived Veza metric names against
 * LIVE Grafana, and reveal the real label keys/values — especially what
 * `tenant_id` actually looks like (UUID vs human name), which decides how we
 * join Grafana metrics to the JIRA "Customer" field.
 *
 * Run: node --env-file=.env.local scripts/phase0/spike-grafana-veza.mjs
 */
const URL = process.env.GRAFANA_URL?.replace(/\/$/, "");
const TOKEN = process.env.GRAFANA_TOKEN;
if (!URL || !TOKEN) {
  console.error("Need GRAFANA_URL and GRAFANA_TOKEN in .env.local");
  process.exit(1);
}
const H = { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" };

async function g(path) {
  const res = await fetch(`${URL}${path}`, { headers: H });
  if (!res.ok) throw new Error(`${res.status} ${path}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
const prom = (uid, q) =>
  g(`/api/datasources/proxy/uid/${uid}/api/v1/query?query=${encodeURIComponent(q)}`);
const labelValues = (uid, label, match) =>
  g(`/api/datasources/proxy/uid/${uid}/api/v1/label/${label}/values?match[]=${encodeURIComponent(match)}`);

async function main() {
  const ds = await g("/api/datasources");
  const proms = ds.filter((d) => d.type === "prometheus");
  console.log(`Prometheus datasources: ${proms.map((d) => `${d.name}(${d.uid})`).join(", ")}\n`);

  const PATTERN = 'veza_platform_parser_.*|.*extraction.*';
  for (const d of proms) {
    let names = [];
    try {
      names = await labelValues(d.uid, "__name__", `{__name__=~"${PATTERN}"}`);
    } catch (e) {
      console.log(`[${d.name}] label query failed: ${e.message}`);
      continue;
    }
    const veza = (names.data ?? []).filter((n) => /veza_platform_parser|extraction/i.test(n));
    if (veza.length === 0) {
      console.log(`[${d.name}] no veza_platform_parser_* / *extraction* metrics`);
      continue;
    }
    console.log(`\n==== [${d.name}] (uid=${d.uid}) — ${veza.length} matching metrics ====`);
    console.log(veza.slice(0, 40).join("\n"));

    // Inspect label keys + sample values on the headline parser metric.
    const probeMetric = veza.find((n) => n === "veza_platform_parser_task_total") ?? veza[0];
    try {
      const r = await prom(d.uid, probeMetric);
      const series = r.data?.result ?? [];
      console.log(`\n  -- label sets on ${probeMetric} (first 8 of ${series.length}) --`);
      for (const s of series.slice(0, 8)) console.log("   " + JSON.stringify(s.metric));
      // What does tenant_id actually look like?
      const tids = await prom(d.uid, `count by (tenant_id) (${probeMetric})`);
      const vals = (tids.data?.result ?? []).map((s) => s.metric.tenant_id).filter(Boolean);
      console.log(`\n  -- distinct tenant_id values (${vals.length}) --`);
      console.log("   " + vals.slice(0, 15).join("\n   "));
      // And the integration label (agent_type / task).
      const ats = await prom(d.uid, `count by (agent_type) (${probeMetric})`);
      const av = (ats.data?.result ?? []).map((s) => s.metric.agent_type).filter(Boolean);
      if (av.length) console.log(`\n  -- distinct agent_type values --\n   ${av.slice(0, 20).join(", ")}`);
    } catch (e) {
      console.log(`  probe failed: ${e.message}`);
    }
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

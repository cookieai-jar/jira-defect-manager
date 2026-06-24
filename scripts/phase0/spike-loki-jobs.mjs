#!/usr/bin/env node
/** Compare FINISH-line counts vs DISTINCT job_id counts for a tenant.
 * Run: LOKI_DS=<uid> node --env-file=.env.local scripts/phase0/spike-loki-jobs.mjs [tenant] */
const URL = process.env.GRAFANA_URL?.replace(/\/$/, "");
const TOKEN = process.env.GRAFANA_TOKEN;
const DS = process.env.LOKI_DS || "bf62i2xnmslxcf"; // bcgprod = vezalondon
const TENANT = process.argv[2] || "bcgprod";
const H = { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" };
const base = `/api/datasources/proxy/uid/${DS}/loki/api/v1`;
async function g(p) { const r = await fetch(URL + p, { headers: H }); const t = await r.text(); if (!r.ok) throw new Error(`${r.status}: ${t.slice(0,160)}`); return JSON.parse(t); }
const ns = () => `${Date.now()}000000`;
const ago = (h) => `${Date.now() - h * 3600 * 1000}000000`;
const inst = (q) => g(`${base}/query?query=${encodeURIComponent(q)}&time=${ns()}`);
const val = (x) => x?.data?.result?.[0]?.value?.[1] ?? "0";
const NS = `{namespace="${TENANT}-dp"}`;
const FIN = "FINISH - Extracting data source";
const STA = "START - Extracting data source";

async function section(t, fn) { console.log(`\n== ${t} ==`); try { await fn(); } catch (e) { console.log(`  FAILED: ${e.message}`); } }

async function main() {
  console.log(`${TENANT}  ds=${DS}`);

  for (const H_ of [0.05, 1, 24]) {
    await section(`${H_}h window`, async () => {
      const finLines = await inst(`sum(count_over_time(${NS} |= \`${FIN}\` [${H_}h]))`);
      const staLines = await inst(`sum(count_over_time(${NS} |= \`${STA}\` [${H_}h]))`);
      console.log(`  FINISH lines: ${val(finLines)}   START lines: ${val(staLines)}`);
      // distinct job_id (over all extraction lines)
      try {
        const distinct = await inst(`count(count by (job_id) (count_over_time(${NS} |= \`Extracting data source\` | json [${H_}h]))) `);
        console.log(`  DISTINCT job_id: ${val(distinct)}`);
      } catch (e) { console.log(`  distinct job_id FAILED: ${e.message}`); }
      // distinct datasource_id
      try {
        const dsids = await inst(`count(count by (datasource_id) (count_over_time(${NS} |= \`${FIN}\` | json [${H_}h])))`);
        console.log(`  DISTINCT datasource_id (FINISH): ${val(dsids)}`);
      } catch (e) { console.log(`  distinct datasource_id FAILED: ${e.message}`); }
    });
  }

  await section("sample: do FINISH lines repeat the same job_id?", async () => {
    const r = await g(`${base}/query_range?query=${encodeURIComponent(`${NS} |= \`${FIN}\` | json`)}&start=${ago(1)}&end=${ns()}&limit=20&direction=backward`);
    const lines = (r?.data?.result ?? []).flatMap((s) => (s.values ?? []).map((v) => v[1]));
    const seen = {};
    for (const l of lines) {
      try { const j = JSON.parse(l); const k = j.job_id; seen[k] = (seen[k] ?? 0) + 1; } catch {}
    }
    const ids = Object.entries(seen);
    console.log(`  ${lines.length} sample FINISH lines -> ${ids.length} distinct job_id`);
    for (const [k, c] of ids.slice(0, 8)) console.log(`    job_id ${String(k).slice(0,20)}… x${c}`);
    // show one full line's relevant fields
    try { const j = JSON.parse(lines[0]); console.log("  sample fields:", JSON.stringify({ job_id: j.job_id, datasource_id: j.datasource_id, datasource_type: j.datasource_type, external_id: j.external_id })); } catch {}
  });
}
main().catch((e) => { console.error(e); process.exit(1); });

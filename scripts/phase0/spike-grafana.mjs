#!/usr/bin/env node
/**
 * Phase-0 Grafana/Prometheus discovery spike.
 *
 * Run once credentials land:
 *   node --env-file=.env.local scripts/phase0/spike-grafana.mjs
 *
 * Goal: discover the real Prometheus metric names and the tenant / integration
 * label keys we'll build the dashboard on. Standalone — global fetch, env only,
 * no imports from src.
 */

const URL_RAW = process.env.GRAFANA_URL;
const TOKEN = process.env.GRAFANA_TOKEN;
const PROM_UID = process.env.GRAFANA_PROM_DATASOURCE_UID;

if (!URL_RAW || !TOKEN) {
  console.error("Missing Grafana credentials. Add to .env.local:");
  console.error("  GRAFANA_URL=https://your-grafana-host");
  console.error("  GRAFANA_TOKEN=glsa_xxx                       # service-account / API token");
  console.error("  GRAFANA_PROM_DATASOURCE_UID=xxxxxxxx         # optional; spike will find it");
  process.exit(1);
}

const BASE = URL_RAW.replace(/\/$/, "");
const HEADERS = { Accept: "application/json", Authorization: `Bearer ${TOKEN}` };

const METRIC_INTEREST = /extract|parse|node|edge|entit|error/i;

async function getJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${res.status} ${url}\n${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 200)}`);
  }
}

function promBase(uid) {
  return uid ? `${BASE}/api/datasources/proxy/uid/${uid}/api/v1` : `${BASE}/api/v1`;
}

async function main() {
  console.log(`Grafana: ${BASE}`);

  // 1. List datasources to find the Prometheus uid.
  let uid = PROM_UID;
  try {
    const ds = await getJson(`${BASE}/api/datasources`);
    console.log(`\n== Datasources (${ds.length}) ==`);
    for (const d of ds) {
      console.log(`  [${d.type}] name="${d.name}" uid=${d.uid}${d.isDefault ? " (default)" : ""}`);
    }
    if (!uid) {
      const prom = ds.find((d) => d.type === "prometheus" && d.isDefault) ||
        ds.find((d) => d.type === "prometheus");
      if (prom) {
        uid = prom.uid;
        console.log(`\nUsing Prometheus datasource uid=${uid} (name="${prom.name}")`);
        console.log("  -> consider setting GRAFANA_PROM_DATASOURCE_UID to this in .env.local");
      }
    }
  } catch (err) {
    console.error(`\nCould not list datasources: ${err.message}`);
    console.error("Falling back to direct Prometheus proxy path.");
  }

  const PB = promBase(uid);

  // 2. List metric names via the label values endpoint (cheap vs scraping series).
  let names = [];
  try {
    const resp = await getJson(`${PB}/label/__name__/values`);
    names = Array.isArray(resp.data) ? resp.data : [];
    console.log(`\n== Metric names: ${names.length} total ==`);
  } catch (err) {
    console.error(`\nCould not list metric names at ${PB}/label/__name__/values: ${err.message}`);
    process.exit(1);
  }

  const candidates = names.filter((n) => METRIC_INTEREST.test(n));
  console.log(`\n== Candidate metrics matching /extract|parse|node|edge|entit|error/i (${candidates.length}) ==`);
  for (const n of candidates) console.log(`  ${n}`);

  // 3. For each candidate, query one series and show its label keys so we can
  //    spot the tenant / integration label names.
  console.log(`\n== Label keys per candidate (one sample series each) ==`);
  for (const name of candidates) {
    try {
      const q = `${PB}/query?query=${encodeURIComponent(name)}`;
      const resp = await getJson(q);
      const result = resp?.data?.result ?? [];
      if (result.length === 0) {
        console.log(`  ${name}: (no current series)`);
        continue;
      }
      const labelKeys = new Set();
      for (const r of result.slice(0, 25)) {
        for (const k of Object.keys(r.metric ?? {})) labelKeys.add(k);
      }
      console.log(`  ${name}: ${result.length} series; labels = [${[...labelKeys].sort().join(", ")}]`);
      console.log(`     example metric = ${JSON.stringify(result[0].metric)}`);
    } catch (err) {
      console.log(`  ${name}: query failed — ${err.message}`);
    }
  }

  console.log(`\nDone. Look above for the label key that names the tenant and the one that names the integration.`);
}

main().catch((err) => {
  console.error(`\nSpike failed: ${err.message}`);
  process.exit(1);
});

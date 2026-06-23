#!/usr/bin/env node
/**
 * Phase 0 spike: discover the JIRA "Customer" custom field id and value shape,
 * so we can join JIRA tickets to a Grafana tenant name.
 *
 * Run:  node --env-file=.env.local scripts/phase0/spike-jira-customer-field.mjs [SAMPLE_JQL]
 *
 * It (1) lists all fields whose name contains "customer" to find the
 * customfield_XXXXX id and its schema, then (2) pulls a few sample issues that
 * have the field populated to show how multi-select values serialize.
 */

const baseUrl = process.env.JIRA_BASE_URL?.replace(/\/$/, "");
const email = process.env.JIRA_EMAIL;
const token = process.env.JIRA_API_TOKEN;
if (!baseUrl || !email || !token) {
  console.error("Missing JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN in .env.local");
  process.exit(1);
}
const auth = "Basic " + Buffer.from(`${email}:${token}`).toString("base64");

async function jira(path, init = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: auth,
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`JIRA ${res.status} on ${path}: ${(await res.text()).slice(0, 400)}`);
  }
  return res.json();
}

function summarizeValue(v) {
  // Multi-select custom fields usually serialize as an array of { value, id }.
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === "object" ? x.value ?? x.name ?? JSON.stringify(x) : x));
  if (v && typeof v === "object") return v.value ?? v.name ?? JSON.stringify(v);
  return v;
}

async function main() {
  console.log(`\n=== JIRA field catalog: fields matching /customer/i ===`);
  const fields = await jira("/rest/api/3/field");
  const matches = fields.filter((f) => /customer/i.test(f.name));
  if (matches.length === 0) {
    console.log("No field whose name contains 'customer'. Dumping all custom fields instead:");
    for (const f of fields.filter((f) => f.custom)) {
      console.log(`  ${f.id}  ${JSON.stringify(f.name)}  type=${f.schema?.type}/${f.schema?.custom ?? ""}`);
    }
  }
  for (const f of matches) {
    console.log(
      `  id=${f.id}  name=${JSON.stringify(f.name)}  custom=${f.custom}  ` +
        `type=${f.schema?.type}  items=${f.schema?.items ?? "-"}  customType=${f.schema?.custom ?? "-"}`,
    );
  }

  // Only the exact-name "Customer" multi-select fields are real join candidates.
  const candidates = matches.filter(
    (f) => f.custom && f.name === "Customer" && /multiselect/.test(f.schema?.custom ?? ""),
  );
  if (candidates.length === 0) {
    console.log("\nNo multiselect 'Customer' field found — check the field name in JIRA.");
    return;
  }
  console.log(`\nJoin candidate(s): ${candidates.map((f) => f.id).join(", ")}`);

  // Probe sample issues for each candidate field. JIRA rejects unbounded JQL,
  // so default to a bounded recent-issues query.
  const jql = process.argv[2] || "updated >= -52w ORDER BY updated DESC";
  for (const f of candidates) {
    console.log(`\n=== Sample values for ${f.id} (${JSON.stringify(f.name)}) ===`);
    const res = await jira("/rest/api/3/search/jql", {
      method: "POST",
      body: JSON.stringify({ jql, fields: [f.id, "summary"], maxResults: 25 }),
    });
    let shown = 0;
    for (const issue of res.issues ?? []) {
      const raw = issue.fields?.[f.id];
      if (raw == null || (Array.isArray(raw) && raw.length === 0)) continue;
      console.log(`  ${issue.key}: ${JSON.stringify(summarizeValue(raw))}`);
      if (++shown >= 8) break;
    }
    if (shown === 0) console.log("  (no sampled issue in this JQL had the field populated — try a tenant-specific JQL arg)");
    console.log(`  RAW shape of first populated value:`);
    const firstRaw = (res.issues ?? []).map((i) => i.fields?.[f.id]).find((v) => v != null && !(Array.isArray(v) && v.length === 0));
    console.log("  " + JSON.stringify(firstRaw, null, 2)?.split("\n").join("\n  "));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

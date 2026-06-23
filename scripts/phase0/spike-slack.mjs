#!/usr/bin/env node
/**
 * Phase-0 Slack alert-format discovery spike.
 *
 * Run once credentials land:
 *   node --env-file=.env.local scripts/phase0/spike-slack.mjs
 *
 * Goal: confirm bot auth and see the REAL alert message format in the
 * configured channels so we can harden parseAlert. Standalone — global fetch,
 * env only, no imports from src.
 */

const TOKEN = process.env.SLACK_BOT_TOKEN;
const CHANNELS_RAW = process.env.SLACK_ALERT_CHANNEL_IDS;

if (!TOKEN) {
  console.error("Missing Slack credentials. Add to .env.local:");
  console.error("  SLACK_BOT_TOKEN=xoxb-...                     # bot token w/ channels:history scope");
  console.error("  SLACK_ALERT_CHANNEL_IDS=C0123ABCD,C0456EFGH  # comma-separated channel ids");
  process.exit(1);
}

const HEADERS = { Accept: "application/json", Authorization: `Bearer ${TOKEN}` };

const channelIds = (CHANNELS_RAW ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

async function slackGet(method, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`https://slack.com/api/${method}${qs ? `?${qs}` : ""}`, {
    headers: HEADERS,
  });
  const json = await res.json();
  return json;
}

/** Inline mirror of src/lib/slack.ts parseAlert (standalone, no src imports). */
function parseAlert(msg) {
  const text = (msg?.text ?? "").trim();
  if (text.length === 0) return null;
  const lower = text.toLowerCase();
  let state = "firing";
  if (lower.includes("[resolved]") || lower.includes(":large_green_circle:")) state = "resolved";
  else if (lower.includes("[firing]") || lower.includes(":red_circle:")) state = "firing";
  let kind = "other";
  if (lower.includes("extraction") || lower.includes("extract")) kind = "extraction";
  else if (lower.includes("parse") || lower.includes("parsing")) kind = "parse";
  const name =
    text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? text;
  const seconds = Number(msg.ts);
  const firedAt = Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString()
    : new Date(0).toISOString();
  return { integration: null, kind, name, state, firedAt, source: "slack", url: null };
}

async function main() {
  const auth = await slackGet("auth.test");
  if (!auth.ok) {
    console.error(`auth.test failed: ${auth.error}`);
    process.exit(1);
  }
  console.log(`Authed as bot "${auth.user}" in workspace "${auth.team}" (team=${auth.team_id})`);

  if (channelIds.length === 0) {
    console.error("\nNo channels in SLACK_ALERT_CHANNEL_IDS — set it to inspect alert messages.");
    process.exit(1);
  }

  for (const channel of channelIds) {
    console.log(`\n== Channel ${channel} (last ~20 messages) ==`);
    const resp = await slackGet("conversations.history", { channel, limit: "20" });
    if (!resp.ok) {
      console.error(`  conversations.history failed: ${resp.error}`);
      continue;
    }
    const messages = resp.messages ?? [];
    if (messages.length === 0) {
      console.log("  (no messages)");
      continue;
    }
    for (const m of messages) {
      const firstLine = (m.text ?? "").split("\n")[0].slice(0, 120);
      console.log(`  ts=${m.ts}  "${firstLine}"`);
      console.log(`     parseAlert -> ${JSON.stringify(parseAlert(m))}`);
    }
  }

  console.log("\nDone. Compare the raw first lines against the parseAlert output to tune src/lib/slack.ts.");
}

main().catch((err) => {
  console.error(`\nSpike failed: ${err.message}`);
  process.exit(1);
});

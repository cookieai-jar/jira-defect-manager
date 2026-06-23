import type { TenantAlert } from "@/types/tenant";

interface SlackEnv {
  token: string;
}

function env(): SlackEnv {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    throw new Error(
      "Missing Slack credentials. Set SLACK_BOT_TOKEN (and SLACK_ALERT_CHANNEL_IDS) in .env.local",
    );
  }
  return { token };
}

export interface SlackMessage {
  ts: string;
  text: string;
  /** Slack passes through any other fields untouched. */
  [key: string]: unknown;
}

async function slackFetch<T>(path: string, e: SlackEnv): Promise<T> {
  const res = await fetch(`https://slack.com/api/${path}`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${e.token}`,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Slack ${res.status} on ${path}: ${text.slice(0, 500)}`);
  }
  return (await res.json()) as T;
}

/**
 * Parse the comma-separated SLACK_ALERT_CHANNEL_IDS env into a list of channel
 * ids. Empty/missing env yields an empty list (clients fail gracefully).
 */
export function alertChannelIds(): string[] {
  return (process.env.SLACK_ALERT_CHANNEL_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Fetch recent messages from a Slack channel via conversations.history.
 * Slack returns { ok, messages: [{ ts, text, ... }] }; throws on ok:false with
 * the Slack error code.
 */
export async function fetchChannelMessages(
  channelId: string,
  oldestSec?: number,
): Promise<SlackMessage[]> {
  const e = env();
  const params = new URLSearchParams({ channel: channelId });
  if (oldestSec !== undefined) params.set("oldest", String(oldestSec));
  const json = await slackFetch<{ ok: boolean; error?: string; messages?: SlackMessage[] }>(
    `conversations.history?${params.toString()}`,
    e,
  );
  if (!json.ok) {
    throw new Error(`Slack conversations.history failed: ${json.error ?? "unknown error"}`);
  }
  return json.messages ?? [];
}

/** Slack ts is "seconds.micros"; convert to an ISO string. NaN-safe. */
function slackTsToIso(ts: string): string {
  const seconds = Number(ts);
  if (!Number.isFinite(seconds)) return new Date(0).toISOString();
  return new Date(seconds * 1000).toISOString();
}

/**
 * PURE. Best-effort parse of a Grafana-style alert message posted to Slack into a
 * TenantAlert. Returns null when the text is empty.
 *
 *  - state: "[FIRING]" / ":red_circle:" → firing; "[RESOLVED]" /
 *    ":large_green_circle:" → resolved; defaults to "firing".
 *  - kind: "parse" / "extraction" keywords; otherwise "other".
 *  - name: first non-empty line, trimmed.
 *  - firedAt: derived from the Slack ts.
 *  - integration / url: left null for later correlation.
 */
export function parseAlert(msg: { text: string; ts: string }): TenantAlert | null {
  const text = (msg?.text ?? "").trim();
  if (text.length === 0) return null;

  const lower = text.toLowerCase();

  let state: TenantAlert["state"] = "firing";
  if (lower.includes("[resolved]") || lower.includes(":large_green_circle:")) {
    state = "resolved";
  } else if (lower.includes("[firing]") || lower.includes(":red_circle:")) {
    state = "firing";
  }

  let kind: TenantAlert["kind"] = "other";
  if (lower.includes("extraction") || lower.includes("extract")) {
    kind = "extraction";
  } else if (lower.includes("parse") || lower.includes("parsing")) {
    kind = "parse";
  }

  const name =
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? text;

  return {
    integration: null,
    kind,
    name,
    state,
    firedAt: slackTsToIso(msg.ts),
    source: "slack",
    url: null,
  };
}

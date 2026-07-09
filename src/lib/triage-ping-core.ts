/**
 * Pure logic for the triage-queue "ping assignee for an update" action —
 * the ADF comment body and the ping-count/last-ping stats derived from an
 * issue's comments. No Anthropic/db/jira import, so it's client-safe (the
 * triage table computes stats locally) and unit-testable.
 */

type AdfNode = { type: string; [k: string]: unknown };

/** Footer marker identifying one of OUR "request an update" pings. */
const UPDATE_PING_MARKER = /\(update requested\)/i;

/**
 * Build the ADF comment that @-mentions the assignee asking for a status
 * update. Returns null when there is no one to ping (unassigned).
 */
export function buildUpdateRequestComment(opts: {
  assigneeAccountId: string | null;
  assigneeName: string | null;
}): { type: "doc"; version: 1; content: AdfNode[] } | null {
  if (!opts.assigneeAccountId) return null;
  const inline: AdfNode[] = [
    { type: "mention", attrs: { id: opts.assigneeAccountId, text: `@${opts.assigneeName ?? "assignee"}` } },
    {
      type: "text",
      text: " — could you please post a status update on this ticket? Where does it stand and what are the next steps? (Update requested)",
    },
  ];
  return { type: "doc", version: 1, content: [{ type: "paragraph", content: inline }] };
}

/**
 * PURE. Count our update-request pings on an issue + the most-recent one's
 * timestamp. Authoritative + retroactive: the JIRA comment IS the ping record.
 */
export function updatePingStats(
  comments: { createdAt: string; text: string }[],
): { count: number; lastPingedAt: string | null } {
  const pings = comments.filter((c) => UPDATE_PING_MARKER.test(c.text));
  if (pings.length === 0) return { count: 0, lastPingedAt: null };
  const last = pings.reduce((a, b) => (a.createdAt > b.createdAt ? a : b)).createdAt;
  return { count: pings.length, lastPingedAt: last };
}

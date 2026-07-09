import { NextResponse } from "next/server";
import { addIssueComment, fetchIssueAssignee } from "@/lib/jira";
import { buildUpdateRequestComment } from "@/lib/triage-ping-core";
import { isSafeIdentifier } from "@/lib/rca-core";

// Outward-facing write (posts a JIRA comment, notifies the assignee).
export const dynamic = "force-dynamic";

/**
 * POST { issueKey } → comment on the ticket @-mentioning its CURRENT assignee to
 * ask for a status update. Re-fetches the assignee first so we mention whoever
 * owns it now (not a stale synced value) and skip unassigned tickets.
 */
export async function POST(req: Request) {
  try {
    const { issueKey } = (await req.json()) as { issueKey?: string };
    if (!issueKey || !isSafeIdentifier(issueKey)) {
      return NextResponse.json({ ok: false, error: "valid issueKey required" }, { status: 400 });
    }
    const assignee = await fetchIssueAssignee(issueKey);
    if (!assignee) {
      return NextResponse.json({
        ok: true,
        posted: false,
        message: "Ticket is unassigned — no one to ping.",
      });
    }
    const body = buildUpdateRequestComment({
      assigneeAccountId: assignee.accountId,
      assigneeName: assignee.displayName,
    });
    if (!body) {
      return NextResponse.json({ ok: true, posted: false, message: "Nothing to ping." });
    }
    // The comment itself is the ping record (counted from JIRA comments on load).
    await addIssueComment(issueKey, body);
    return NextResponse.json({ ok: true, posted: true, assignee: assignee.displayName });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error }, { status: 200 });
  }
}

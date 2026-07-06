import { NextResponse } from "next/server";
import { fetchRoadmapIssue, addIssueComment } from "@/lib/jira";
import { buildMissingFieldsComment } from "@/lib/fr-roadmap";
import { isSafeIdentifier } from "@/lib/rca-core";

// Outward-facing write (posts a JIRA comment, notifies the assignee).
export const dynamic = "force-dynamic";

/**
 * POST { issueKey } → comment on the EAC pinging its assignee to fill the missing
 * planning fields. Re-fetches the issue first so we (a) use the CURRENT assignee
 * and (b) never comment when the fields have since been filled.
 */
export async function POST(req: Request) {
  try {
    const { issueKey } = (await req.json()) as { issueKey?: string };
    if (!issueKey || !isSafeIdentifier(issueKey)) {
      return NextResponse.json({ ok: false, error: "valid issueKey required" }, { status: 400 });
    }
    const issue = await fetchRoadmapIssue(issueKey);
    if (issue.missingFields.length === 0) {
      return NextResponse.json({ ok: true, posted: false, message: "No missing fields — nothing to ping." });
    }
    const body = buildMissingFieldsComment({
      assigneeAccountId: issue.assignee?.accountId ?? null,
      assigneeName: issue.assignee?.displayName ?? null,
      missingFields: issue.missingFields,
    });
    if (!body) {
      return NextResponse.json({ ok: true, posted: false, message: "Nothing to ping." });
    }
    // The comment itself is the ping record (counted from JIRA comments on load).
    await addIssueComment(issueKey, body);
    return NextResponse.json({
      ok: true,
      posted: true,
      assignee: issue.assignee?.displayName ?? null,
      missingFields: issue.missingFields,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error }, { status: 200 });
  }
}

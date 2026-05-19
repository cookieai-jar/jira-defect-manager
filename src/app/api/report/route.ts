import { NextResponse } from "next/server";
import { latestReport, listIssues } from "@/lib/db";
import { isScope } from "@/types/triage";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const scope = url.searchParams.get("scope");
  if (!isScope(scope)) {
    return NextResponse.json({ error: "scope must be 'eac' or 'fr'" }, { status: 400 });
  }
  const jiraBaseUrl = process.env.JIRA_BASE_URL?.replace(/\/$/, "") ?? "";
  const report = latestReport(scope);
  if (!report) {
    return NextResponse.json({ report: null, issues: [], jiraBaseUrl });
  }
  const issues = listIssues(scope);
  return NextResponse.json({ report, issues, jiraBaseUrl });
}

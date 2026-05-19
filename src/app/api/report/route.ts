import { NextResponse } from "next/server";
import { latestReport, listIssues } from "@/lib/db";

export async function GET() {
  const jiraBaseUrl = process.env.JIRA_BASE_URL?.replace(/\/$/, "") ?? "";
  const report = latestReport();
  if (!report) {
    return NextResponse.json({ report: null, issues: [], jiraBaseUrl });
  }
  const issues = listIssues();
  return NextResponse.json({ report, issues, jiraBaseUrl });
}

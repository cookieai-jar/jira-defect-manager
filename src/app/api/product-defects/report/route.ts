import { NextResponse } from "next/server";
import { latestProductDefectReport, listProductDefectIssues } from "@/lib/db";

export async function GET() {
  const jiraBaseUrl = process.env.JIRA_BASE_URL?.replace(/\/$/, "") ?? "";
  const report = latestProductDefectReport();
  if (!report) {
    return NextResponse.json({ report: null, issues: [], jiraBaseUrl });
  }
  const issues = listProductDefectIssues();
  return NextResponse.json({ report, issues, jiraBaseUrl });
}

import { NextResponse } from "next/server";
import { latestReport, listIssues } from "@/lib/db";

export async function GET() {
  const report = latestReport();
  if (!report) {
    return NextResponse.json({ report: null, issues: [] });
  }
  const issues = listIssues();
  return NextResponse.json({ report, issues });
}

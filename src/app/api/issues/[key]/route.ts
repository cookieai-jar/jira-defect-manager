import { NextResponse } from "next/server";
import {
  getAnalysis,
  getIntegrationIssue,
  getIssue,
  getProductDefectIssue,
} from "@/lib/db";

export async function GET(_req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  // The triage `issues` table only holds the per-scope populations. Dashboards
  // that keep their own ticket store (Strategic Integrations, Product Defect
  // Analysis) pull from far wider JQLs, so a key they render is often absent
  // here — fall through to those stores before giving up, otherwise their
  // ticket drawer 404s on most rows.
  const issue = getIssue(key) ?? getProductDefectIssue(key) ?? getIntegrationIssue(key);
  if (!issue) return NextResponse.json({ error: "not found" }, { status: 404 });
  const analysis = getAnalysis(key);
  return NextResponse.json({ issue, analysis });
}

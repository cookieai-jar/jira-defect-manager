import { NextResponse } from "next/server";
import { getAnalysis, getIssue } from "@/lib/db";

export async function GET(_req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const issue = getIssue(key);
  if (!issue) return NextResponse.json({ error: "not found" }, { status: 404 });
  const analysis = getAnalysis(key);
  return NextResponse.json({ issue, analysis });
}

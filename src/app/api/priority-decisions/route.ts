import { NextResponse } from "next/server";
import { z } from "zod";
import { getIssue, listDecisions, upsertDecision } from "@/lib/db";

const PrioritySchema = z.enum(["P0", "P1", "P2", "P3"]);

const PostSchema = z.object({
  issueKey: z.string().min(1),
  decision: z.literal("ignore"),
  decidedPriorityChange: z.enum(["raise", "lower", "keep"]).nullable().optional(),
  decidedRecommendedPriority: PrioritySchema.nullable().optional(),
  decidedCurrentPriority: PrioritySchema.nullable().optional(),
});

export async function GET() {
  return NextResponse.json(listDecisions());
}

export async function POST(req: Request) {
  const body = await req.json();
  const parsed = PostSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  // Snapshot the JIRA updated timestamp so we can later detect activity since
  // the decision was made.
  const issue = getIssue(parsed.data.issueKey);
  const decidedTicketUpdatedAt = issue?.updated ?? null;
  const next = {
    issueKey: parsed.data.issueKey,
    decision: "ignore" as const,
    decidedAt: new Date().toISOString(),
    decidedPriorityChange: parsed.data.decidedPriorityChange ?? null,
    decidedRecommendedPriority: parsed.data.decidedRecommendedPriority ?? null,
    decidedCurrentPriority: parsed.data.decidedCurrentPriority ?? null,
    decidedTicketUpdatedAt,
    revisitFlagged: false,
    revisitReason: null,
  };
  upsertDecision(next);
  return NextResponse.json(next, { status: 201 });
}

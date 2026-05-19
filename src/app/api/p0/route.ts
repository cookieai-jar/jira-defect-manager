import { NextResponse } from "next/server";
import { listP0, upsertP0 } from "@/lib/db";
import { z } from "zod";
import { randomUUID } from "node:crypto";

const CreateSchema = z.object({
  name: z.string().min(1),
  jqlFragment: z.string().min(1),
  notes: z.string().nullable().optional(),
});

export async function GET() {
  return NextResponse.json(listP0());
}

export async function POST(req: Request) {
  const body = await req.json();
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const customer = {
    id: randomUUID(),
    name: parsed.data.name,
    jqlFragment: parsed.data.jqlFragment,
    notes: parsed.data.notes ?? null,
    createdAt: new Date().toISOString(),
    lastAnalyzedAt: null,
  };
  upsertP0(customer);
  return NextResponse.json(customer, { status: 201 });
}

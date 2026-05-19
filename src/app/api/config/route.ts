import { NextResponse } from "next/server";
import { getConfig, saveConfig } from "@/lib/config";
import { z } from "zod";

const PatchSchema = z.object({
  jqls: z
    .object({
      eac: z.string().min(1).optional(),
      fr: z.string().min(1).optional(),
      sec: z.string().min(1).optional(),
    })
    .optional(),
  dashboards: z
    .object({
      eac: z.boolean().optional(),
      fr: z.boolean().optional(),
      sec: z.boolean().optional(),
    })
    .optional(),
  sprintLengthDays: z.number().int().min(1).max(60).optional(),
  inactivityThresholdDays: z.number().int().min(1).max(365).optional(),
  pingThresholdDays: z.number().int().min(1).max(60).optional(),
  model: z.string().min(1).optional(),
  maxIssuesPerSync: z.number().int().min(1).max(2000).optional(),
});

export async function GET() {
  return NextResponse.json(getConfig());
}

export async function PUT(req: Request) {
  const body = await req.json();
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const next = saveConfig(parsed.data);
  return NextResponse.json(next);
}

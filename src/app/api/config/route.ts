import { NextResponse } from "next/server";
import { getConfig, saveConfig, type AppConfigPatch } from "@/lib/config";
import { SCOPES, type Scope } from "@/types/triage";
import { z } from "zod";

// Build the per-scope shapes from SCOPES so adding a scope never leaves this
// PUT schema behind — an omitted scope key is silently stripped on save, which
// would make that scope's JQL / visibility edits in Settings a no-op.
const jqlShape = Object.fromEntries(
  SCOPES.map((s) => [s, z.string().min(1).optional()]),
) as Record<Scope, z.ZodOptional<z.ZodString>>;
const dashboardShape = Object.fromEntries(
  SCOPES.map((s) => [s, z.boolean().optional()]),
) as Record<Scope, z.ZodOptional<z.ZodBoolean>>;

const PatchSchema = z.object({
  jqls: z.object(jqlShape).optional(),
  dashboards: z.object(dashboardShape).optional(),
  siJql: z.string().min(1).optional(),
  siDashboard: z.boolean().optional(),
  pdaJql: z.string().min(1).optional(),
  pdaDashboard: z.boolean().optional(),
  codeRepoPath: z.string().min(1).optional(),
  pdaComponentMinDefects: z.number().int().min(1).max(1000).optional(),
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
  const next = saveConfig(parsed.data as AppConfigPatch);
  return NextResponse.json(next);
}

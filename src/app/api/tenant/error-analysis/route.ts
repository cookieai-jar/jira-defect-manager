import { NextResponse } from "next/server";
import { analyzeIntegrationErrors, isSafeIdentifier } from "@/lib/error-analysis";
import type { IntegrationErrorSignals } from "@/types/tenant";

// One RCA per request; the client fans out across failing integrations.
export const dynamic = "force-dynamic";
// RCA gathers Loki samples + an Opus completion; give it room.
export const maxDuration = 120;

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { tenant?: string; signals?: IntegrationErrorSignals };
    const tenant = body.tenant?.trim();
    const signals = body.signals;
    if (!tenant || !signals?.integration) {
      return NextResponse.json({ result: null, error: "tenant and signals.integration are required" }, { status: 400 });
    }
    // tenant + integration are interpolated into LogQL selectors — reject anything
    // outside the slug/agent_type charset to prevent query injection / cross-tenant reads.
    if (!isSafeIdentifier(tenant) || !isSafeIdentifier(signals.integration)) {
      return NextResponse.json({ result: null, error: "invalid tenant or integration identifier" }, { status: 400 });
    }
    const result = await analyzeIntegrationErrors({ tenant, signals });
    return NextResponse.json({ result });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ result: null, error }, { status: 200 });
  }
}

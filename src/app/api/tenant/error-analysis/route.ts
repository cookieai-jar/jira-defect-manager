import { NextResponse } from "next/server";
import { analyzeIntegrationErrors, isSafeIdentifier } from "@/lib/error-analysis";
import { saveRcaResult, listRcaResults, deleteRcaResults } from "@/lib/db";
import type { IntegrationErrorSignals } from "@/types/tenant";

// One RCA per request; the client fans out across failing integrations.
export const dynamic = "force-dynamic";
// RCA gathers Loki samples + an Opus completion; give it room.
export const maxDuration = 120;

/** GET ?tenant=… → persisted RCAs for the tenant (seeds the UI on load). */
export async function GET(req: Request) {
  const tenant = new URL(req.url).searchParams.get("tenant")?.trim();
  if (!tenant || !isSafeIdentifier(tenant)) {
    return NextResponse.json({ results: [], error: "invalid tenant" }, { status: 400 });
  }
  try {
    return NextResponse.json({ results: listRcaResults(tenant) });
  } catch (err) {
    return NextResponse.json({ results: [], error: err instanceof Error ? err.message : String(err) }, { status: 200 });
  }
}

/** POST {tenant, signals} → run RCA for one integration, persist, return it. */
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
    try {
      saveRcaResult(tenant, result);
    } catch (e) {
      console.warn("[error-analysis] persist failed:", e instanceof Error ? e.message : e);
    }
    return NextResponse.json({ result });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ result: null, error }, { status: 200 });
  }
}

/** DELETE ?tenant=…[&integration=…] → clear persisted RCAs. */
export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const tenant = url.searchParams.get("tenant")?.trim();
  const integration = url.searchParams.get("integration")?.trim() || undefined;
  if (!tenant || !isSafeIdentifier(tenant) || (integration && !isSafeIdentifier(integration))) {
    return NextResponse.json({ ok: false, error: "invalid tenant or integration" }, { status: 400 });
  }
  try {
    deleteRcaResults(tenant, integration);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 200 });
  }
}

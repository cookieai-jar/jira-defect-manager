/**
 * Pure RCA helpers safe to import from BOTH server and client. Kept separate
 * from error-analysis.ts (which pulls in the Anthropic SDK + Grafana I/O) so the
 * client bundle can compute staleness without dragging server deps in.
 */
import type { IntegrationErrorSignals } from "@/types/tenant";

/** Coerce a (possibly client-supplied) count to a safe non-negative integer. */
export function safeCount(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
}

/**
 * Stable fingerprint of the error signals an RCA was generated against. When the
 * live signals produce a different fingerprint, the stored analysis is stale (the
 * NATURE of the failure changed). Built only from what determines the root cause:
 * state, severity, and the SET of error_reason codes (order/count-independent).
 *
 * Deliberately EXCLUDES raw counts: `extractionErrors` is a rolling-window
 * counter (increase[24h]) and `failing` a gauge that fluctuates as datasources
 * retry — including either would flip a still-accurate RCA to "stale" on almost
 * every refresh. State/severity transitions already capture recovery/escalation;
 * the reason set captures new failure modes.
 */
export function signalsFingerprint(signals: IntegrationErrorSignals): string {
  const reasons = [...new Set((signals.topReasons ?? []).map((r) => `${r.reason}:${r.errorClass}`))]
    .sort()
    .join(",");
  return [signals.state, signals.severity, reasons].join("|");
}

/**
 * Deep root-cause analysis for failing integrations. Gathers the rich error
 * signals we already collect (classified error_reason codes, failing counts,
 * staleness, plus raw Loki error lines incl. pipeline_error + stacktrace) and
 * asks Claude to produce a concrete RCA + fix guidance per integration.
 *
 * No live source access — the analysis reasons from the error evidence and the
 * model's knowledge of these integration types. The client orchestrates the
 * "analyze all" fan-out (bounded concurrency) so results stream in per call.
 */
import { defaultModel, jsonCompletion } from "./anthropic";
import { findTenantLogDatasource, errorSamplesByTypeQuery, normalizeErrorSignature } from "./tenant-logs";
import { lokiLogLines } from "./grafana";
import { safeCount, signalsFingerprint, isSafeIdentifier } from "./rca-core";
import type { ErrorRcaResult, IntegrationErrorSignals } from "@/types/tenant";

export { signalsFingerprint, isSafeIdentifier } from "./rca-core";

/** Cap how much client-supplied context reaches the prompt (cost / injection surface). */
const MAX_PROMPT_REASONS = 8;

/** A distinct error log sample picked for the prompt. */
export interface ErrorSample {
  signature: string;
  error: string;
  pipelineError: string | null;
  stacktrace: string | null;
  count: number;
}

/**
 * PURE. Pick up to `max` DISTINCT error samples from raw Loki JSON log lines,
 * collapsing by normalized signature so we don't feed the model N identical
 * failures. Keeps the first example (with its stacktrace) per signature and
 * tallies how many lines collapsed into it. Lines without an error are skipped.
 */
export function pickDistinctErrorSamples(lines: string[], max = 6): ErrorSample[] {
  const bySig = new Map<string, ErrorSample>();
  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const error = typeof obj.error === "string" ? obj.error : "";
    const pipelineError = typeof obj.pipeline_error === "string" ? obj.pipeline_error : null;
    const raw = error || pipelineError || "";
    if (!raw) continue;
    const signature = normalizeErrorSignature(raw);
    const existing = bySig.get(signature);
    if (existing) {
      existing.count += 1;
      continue;
    }
    bySig.set(signature, {
      signature,
      error: error.slice(0, 500),
      pipelineError: pipelineError ? pipelineError.slice(0, 500) : null,
      stacktrace: typeof obj.stacktrace === "string" ? obj.stacktrace.slice(0, 1000) : null,
      count: 1,
    });
  }
  return [...bySig.values()].sort((a, b) => b.count - a.count).slice(0, max);
}

/** PURE. Human-readable age for the prompt. */
function age(sec: number | null): string {
  if (sec == null) return "unknown";
  if (sec < 90) return `${Math.round(sec)}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  if (sec < 172800) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

/**
 * PURE. Render one integration's signals + log samples into the user prompt.
 * Kept separate from the I/O so it can be unit-tested deterministically.
 */
export function compactErrorContext(
  tenant: string,
  signals: IntegrationErrorSignals,
  samples: ErrorSample[],
  windowHours: number,
  lokiAvailable = true,
): string {
  const noSamples = lokiAvailable
    ? "(no raw error log lines found in window)"
    : "(regional Loki unavailable — no log samples; analyze from metrics only and lower confidence)";
  // Cap + sanitize client-supplied reasons so a bloated/hostile payload can't
  // blow up the prompt or smuggle instructions via reason text.
  const reasons = signals.topReasons.length
    ? signals.topReasons
        .slice(0, MAX_PROMPT_REASONS)
        .map((r) => `- ${String(r.reason).slice(0, 120)} [${r.errorClass}] ×${safeCount(r.count)}`)
        .join("\n")
    : "- (none reported by the scheduling metric)";
  const sampleText = samples.length
    ? samples
        .map((s, i) => {
          const lines = [`[${i + 1}] (seen ${s.count}×) error: ${s.error || "(empty)"}`];
          if (s.pipelineError) lines.push(`    pipeline_error: ${s.pipelineError}`);
          if (s.stacktrace) lines.push(`    stacktrace: ${s.stacktrace}`);
          return lines.join("\n");
        })
        .join("\n")
    : noSamples;
  return `Tenant: ${tenant}
Integration (agent_type): ${signals.integration}
Window: ${windowHours}h
State: ${signals.state} | Severity: ${signals.severity}
Failing datasources (gauge): ${safeCount(signals.failing)}
Extraction-error log lines in window: ${safeCount(signals.extractionErrors)}
Freshness (since last success): ${age(signals.freshnessSec)} | Oldest pending extract: ${age(signals.lagSec)}

Classified error reasons (most frequent first):
${reasons}

Representative error log samples (distinct signatures):
${sampleText}`;
}

export const RCA_SYSTEM = `You are a senior Veza site-reliability engineer doing root-cause analysis on data-plane extraction failures for one customer tenant. Each integration ("agent_type", e.g. azure_sql, awslambda, okta) extracts identity/access data from a provider's datasources.

You are given, for ONE integration: failure signals (count of currently-failing datasources, staleness/lag, state/severity), the classified error_reason codes with a class label, and representative raw error log lines including pipeline_error and stacktrace where present.

The class label is a strong prior for ownership:
- user  = the customer must fix it (missing/own permissions, expired credentials, network/firewall, quota/rate limits, misconfiguration on their side).
- product = Veza must fix it (code bug, unhandled case, panic/nil-deref, bad pagination, dependency/infra failure).
- unknown = not yet classified.

Do rigorous RCA. Identify the SINGLE most likely root cause and separate it from secondary symptoms. Treat the stacktrace and concrete error text as primary evidence; use the reason class as a prior, not gospel (a stacktrace can reveal a "user"-labelled error is really a product bug, or vice-versa). Be specific and technical; name the failing operation/component. If the evidence is thin or conflicting, say so and lower confidence — do not invent specifics.

Output ONE JSON object with these fields:
- integration: echo the agent_type exactly.
- headline: <=120 chars, plain-language statement of what's broken.
- ownership: "user" | "product" | "unknown" — who must act, per the rules above.
- rootCause: 2-4 sentences. The most probable underlying cause, reasoned from the specific reason codes / error text / stacktrace. Name the failing step.
- evidence: array of 1-4 short strings (<=160 chars) quoting the concrete signals that justify the root cause — a reason code, a log fragment, a stacktrace frame. Quote, don't paraphrase.
- fix: array of 1-5 ordered, concrete remediation steps. For user ownership phrase as customer actions (e.g. "Grant the app registration Directory.Read.All and admin-consent it"). For product, phrase as Veza engineering actions (e.g. "Handle empty nextLink in the AzureSQL pager to stop the nil-deref"). Tie each step to the evidence.
- confidence: "high" | "medium" | "low" — how strongly the evidence supports the root cause.

Return ONLY the JSON object inside a \`\`\`json fence. No prose.`;

interface RawRca {
  integration?: string;
  headline?: string;
  ownership?: string;
  rootCause?: string;
  evidence?: unknown;
  fix?: unknown;
  confidence?: string;
}

function asStringArray(v: unknown, max: number, cap: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "string" ? x : JSON.stringify(x)))
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, max)
    .map((s) => (s.length > cap ? `${s.slice(0, cap)}…` : s));
}

const OWNERSHIP = new Set(["user", "product", "unknown"]);
const CONFIDENCE = new Set(["high", "medium", "low"]);

/**
 * PURE. Normalize/validate the model's raw RCA into a typed result, forcing the
 * integration name (never trust the echo) and clamping enums to safe defaults.
 */
export function normalizeRca(
  raw: RawRca,
  integration: string,
  sampleCount: number,
  generatedAt: string,
  fingerprint: string,
): ErrorRcaResult {
  const ownership = OWNERSHIP.has(raw.ownership ?? "") ? (raw.ownership as ErrorRcaResult["ownership"]) : "unknown";
  const confidence = CONFIDENCE.has(raw.confidence ?? "") ? (raw.confidence as ErrorRcaResult["confidence"]) : "low";
  return {
    integration,
    headline: (raw.headline ?? "").trim().slice(0, 160) || "Root cause analysis unavailable",
    ownership,
    rootCause: (raw.rootCause ?? "").trim() || "The model did not return a root cause.",
    evidence: asStringArray(raw.evidence, 4, 160),
    fix: asStringArray(raw.fix, 5, 400),
    confidence,
    sampleCount,
    generatedAt,
    signalsFingerprint: fingerprint,
  };
}

/**
 * Run deep RCA for one failing integration: fetch its recent error log samples
 * from the tenant's regional Loki, then ask Claude for a root cause + fix.
 * Throws on hard failures (no API key, model error) — the route shapes those.
 */
export async function analyzeIntegrationErrors(opts: {
  tenant: string;
  signals: IntegrationErrorSignals;
  windowHours?: number;
  model?: string;
  now?: number;
}): Promise<ErrorRcaResult> {
  const windowHours = opts.windowHours ?? 24;
  const model = opts.model || defaultModel();
  const now = opts.now ?? Date.now();

  // Defense in depth: these are interpolated into LogQL selectors. The route
  // also validates, but never build a query from an unvalidated identifier.
  if (!isSafeIdentifier(opts.tenant) || !isSafeIdentifier(opts.signals.integration)) {
    throw new Error("Invalid tenant or integration identifier");
  }

  let samples: ErrorSample[] = [];
  let lokiAvailable = false;
  try {
    const dsUid = await findTenantLogDatasource(opts.tenant);
    if (dsUid) {
      lokiAvailable = true;
      const startSec = Math.floor(now / 1000) - windowHours * 3600;
      const endSec = Math.floor(now / 1000);
      const lines = await lokiLogLines(
        dsUid,
        errorSamplesByTypeQuery(opts.tenant, opts.signals.integration),
        startSec,
        endSec,
        200,
      );
      samples = pickDistinctErrorSamples(lines);
    }
  } catch (e) {
    console.warn(
      `[error-analysis] log sample fetch failed for ${opts.tenant}/${opts.signals.integration}:`,
      e instanceof Error ? e.message : e,
    );
  }

  const raw = await jsonCompletion<RawRca>({
    model,
    system: RCA_SYSTEM,
    user: compactErrorContext(opts.tenant, opts.signals, samples, windowHours, lokiAvailable),
    systemCacheable: true,
    maxTokens: 2000,
  });
  return normalizeRca(
    raw,
    opts.signals.integration,
    samples.length,
    new Date(now).toISOString(),
    signalsFingerprint(opts.signals),
  );
}

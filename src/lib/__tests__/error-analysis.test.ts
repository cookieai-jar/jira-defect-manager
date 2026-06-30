import { describe, it, expect } from "vitest";
import { pickDistinctErrorSamples, compactErrorContext, normalizeRca, isSafeIdentifier } from "@/lib/error-analysis";
import { signalsFingerprint } from "@/lib/rca-core";
import { errorSamplesByTypeQuery } from "@/lib/tenant-logs";
import type { IntegrationErrorSignals } from "@/types/tenant";

describe("isSafeIdentifier (LogQL injection guard)", () => {
  it("accepts real tenant slugs and agent_types", () => {
    for (const ok of ["bcgprod", "cookie-prod", "demo-internal", "azure_sql", "active_directory", "awscertificatemanager"]) {
      expect(isSafeIdentifier(ok)).toBe(true);
    }
  });
  it("rejects backticks, quotes, spaces, braces, and over-long input — the injection vectors", () => {
    for (const bad of [
      "bcgprod`} |= `secret",        // backtick break-out
      'a" or namespace=~".*',          // double-quote break-out
      "okta s3",                        // space
      "okta}|json",                      // brace
      "",                                // empty
      "x".repeat(65),                   // too long
    ]) {
      expect(isSafeIdentifier(bad)).toBe(false);
    }
  });
  it("a rejected value can never reach the query builder, but the builder is only safe for validated input", () => {
    // documents the contract: validated identifiers produce a clean, single-filter query
    expect(errorSamplesByTypeQuery("bcgprod", "azure_sql")).toBe(
      '{namespace="bcgprod-dp"} |= `Error extracting data sources` | json | datasource_type=`azure_sql`',
    );
  });
});

describe("pickDistinctErrorSamples", () => {
  it("collapses by normalized signature, tallies counts, keeps stacktrace, ranks by frequency", () => {
    const lines = [
      JSON.stringify({ error: "extract [azure_sql - 019d3047-aaaa]: connect error: cannot reach host", stacktrace: "frame A" }),
      JSON.stringify({ error: "extract [azure_sql - 019d3047-bbbb]: connect error: cannot reach host" }), // same sig
      JSON.stringify({ error: "extract [azure_sql - 019d3047-cccc]: permission denied" }),
      JSON.stringify({ pipeline_error: "rate limited after 9999 attempts" }), // pipeline_error fallback
      "not json",
      JSON.stringify({ datasource_type: "azure_sql" }), // no error/pipeline_error -> skipped
    ];
    const out = pickDistinctErrorSamples(lines);
    expect(out).toHaveLength(3);
    expect(out[0].signature).toBe("connect error: cannot reach host");
    expect(out[0].count).toBe(2); // two ids collapsed
    expect(out[0].stacktrace).toBe("frame A"); // kept from first
    expect(out.some((s) => s.signature === "permission denied")).toBe(true);
    expect(out.some((s) => s.pipelineError === "rate limited after 9999 attempts")).toBe(true);
  });
  it("honors the max cap and truncates long fields", () => {
    const lines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ error: `distinct failure number ${i} ${"x".repeat(800)}` }),
    );
    const out = pickDistinctErrorSamples(lines, 4);
    expect(out).toHaveLength(4);
    expect(out[0].error.length).toBeLessThanOrEqual(500);
  });
  it("returns empty for no parseable error lines", () => {
    expect(pickDistinctErrorSamples(["x", "{}"]).length).toBe(0);
  });
});

const signals: IntegrationErrorSignals = {
  integration: "azure_sql",
  state: "failing",
  severity: "critical",
  failing: 7,
  extractionErrors: 412,
  freshnessSec: 14400,
  lagSec: 90000,
  topReasons: [{ reason: "AUTH_TOKEN_EXPIRED", errorClass: "user", count: 400 }],
};

describe("compactErrorContext", () => {
  it("includes signals, classified reasons, and numbered samples", () => {
    const ctx = compactErrorContext(
      "bcgprod",
      signals,
      [{ signature: "connect error", error: "connect error: cannot reach host", pipelineError: null, stacktrace: "frame A", count: 3 }],
      24,
    );
    expect(ctx).toContain("Integration (agent_type): azure_sql");
    expect(ctx).toContain("Failing datasources (gauge): 7");
    expect(ctx).toContain("AUTH_TOKEN_EXPIRED [user] ×400");
    expect(ctx).toContain("Freshness (since last success): 4h");
    expect(ctx).toContain("Oldest pending extract: 25h"); // 90000s

    expect(ctx).toContain("[1] (seen 3×) error: connect error: cannot reach host");
    expect(ctx).toContain("stacktrace: frame A");
  });
  it("degrades gracefully with no reasons and no samples", () => {
    const bare = { ...signals, topReasons: [] };
    const ctx = compactErrorContext("t", bare, [], 24);
    expect(ctx).toContain("(none reported by the scheduling metric)");
    expect(ctx).toContain("(no raw error log lines found in window)");
  });
  it("caps reasons at 8 and clamps hostile numeric fields (cost / injection surface)", () => {
    const flooded: IntegrationErrorSignals = {
      ...signals,
      failing: -5,
      extractionErrors: Number.POSITIVE_INFINITY,
      topReasons: Array.from({ length: 50 }, (_, i) => ({ reason: `R${i}`, errorClass: "user" as const, count: i })),
    };
    const ctx = compactErrorContext("t", flooded, [], 24);
    expect(ctx.match(/^- R\d+ /gm)?.length).toBe(8); // only 8 reason lines
    expect(ctx).toContain("Failing datasources (gauge): 0"); // negative clamped
    expect(ctx).toContain("Extraction-error log lines in window: 0"); // Infinity -> 0
  });
  it("distinguishes Loki-unavailable from no-errors-found", () => {
    const ctx = compactErrorContext("t", { ...signals, topReasons: [] }, [], 24, false);
    expect(ctx).toContain("regional Loki unavailable");
  });
});

describe("normalizeRca", () => {
  it("forces the integration name and clamps enums to safe defaults", () => {
    const r = normalizeRca(
      { integration: "WRONG", headline: "Auth tokens expired", ownership: "user", rootCause: "Creds lapsed.", evidence: ["AUTH_TOKEN_EXPIRED"], fix: ["Rotate creds", "Re-consent"], confidence: "high" },
      "azure_sql",
      5,
      "2026-06-25T00:00:00.000Z",
      "fp-1",
    );
    expect(r.integration).toBe("azure_sql"); // not the model's echo
    expect(r.ownership).toBe("user");
    expect(r.confidence).toBe("high");
    expect(r.fix).toEqual(["Rotate creds", "Re-consent"]);
    expect(r.sampleCount).toBe(5);
    expect(r.signalsFingerprint).toBe("fp-1");
  });
  it("defaults bad enums and missing fields", () => {
    const r = normalizeRca({ ownership: "banana", confidence: "vibes" }, "okta", 0, "t", "fp");
    expect(r.ownership).toBe("unknown");
    expect(r.confidence).toBe("low");
    expect(r.headline).toBe("Root cause analysis unavailable");
    expect(r.evidence).toEqual([]);
    expect(r.fix).toEqual([]);
  });
  it("coerces non-string evidence/fix entries and caps lengths", () => {
    const r = normalizeRca(
      { evidence: ["ok", { code: 500 }, "", "  "], fix: [`${"y".repeat(500)}`] },
      "s3",
      1,
      "t",
      "fp",
    );
    expect(r.evidence).toContain("ok");
    expect(r.evidence).toContain('{"code":500}');
    expect(r.evidence).not.toContain(""); // blanks dropped
    expect(r.fix[0].length).toBeLessThanOrEqual(401); // 400 + ellipsis
  });
});

describe("signalsFingerprint (stale detection)", () => {
  const base: IntegrationErrorSignals = {
    integration: "azure_sql",
    state: "failing",
    severity: "critical",
    failing: 7,
    extractionErrors: 412,
    freshnessSec: 100,
    lagSec: 200,
    topReasons: [
      { reason: "AUTH_TOKEN_EXPIRED", errorClass: "user", count: 400 },
      { reason: "INTERNAL", errorClass: "internal", count: 12 },
    ],
  };
  it("is stable across reorderings + drifting counts (the perma-stale trap)", () => {
    const drifted = {
      ...base,
      freshnessSec: 9999, // not part of the fingerprint
      lagSec: 1, // not part of the fingerprint
      failing: 999, // gauge fluctuates as datasources retry — must NOT flip stale
      extractionErrors: base.extractionErrors + 1, // rolling counter ticks every window — must NOT flip
      topReasons: [base.topReasons[1], base.topReasons[0]], // order flipped
    };
    expect(signalsFingerprint(drifted)).toBe(signalsFingerprint(base));
  });
  it("changes only when the NATURE of the failure changes (state, severity, or reason set)", () => {
    expect(signalsFingerprint({ ...base, state: "ok" })).not.toBe(signalsFingerprint(base));
    expect(signalsFingerprint({ ...base, severity: "warning" })).not.toBe(signalsFingerprint(base));
    expect(
      signalsFingerprint({ ...base, topReasons: [{ reason: "NEW_REASON", errorClass: "user", count: 1 }] }),
    ).not.toBe(signalsFingerprint(base));
    // adding a brand-new reason class flips it; recount of an existing reason does not
    expect(
      signalsFingerprint({ ...base, topReasons: [{ ...base.topReasons[0], count: 1 }, base.topReasons[1]] }),
    ).toBe(signalsFingerprint(base));
  });
});

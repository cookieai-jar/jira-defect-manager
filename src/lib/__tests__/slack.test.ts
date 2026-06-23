import { describe, it, expect } from "vitest";
import { parseAlert } from "@/lib/slack";

describe("parseAlert", () => {
  it("parses a FIRING extraction alert", () => {
    const alert = parseAlert({
      text: "[FIRING] Extraction stalled for tenant acme\nValue: 30h since last extraction",
      ts: "1700000000.000100",
    });
    expect(alert).toEqual({
      integration: null,
      kind: "extraction",
      name: "[FIRING] Extraction stalled for tenant acme",
      state: "firing",
      severity: "warning",
      reason: null,
      firedAt: "2023-11-14T22:13:20.000Z",
      source: "slack",
      url: null,
    });
  });

  it("parses a RESOLVED parse alert", () => {
    const alert = parseAlert({
      text: "[RESOLVED] Parse failure on globex graph",
      ts: "1700000600.500000",
    });
    expect(alert?.state).toBe("resolved");
    expect(alert?.kind).toBe("parse");
    expect(alert?.name).toBe("[RESOLVED] Parse failure on globex graph");
    expect(alert?.firedAt).toBe("2023-11-14T22:23:20.500Z");
  });

  it("detects state from emoji markers", () => {
    expect(parseAlert({ text: ":red_circle: Something broke", ts: "1700000000" })?.state).toBe(
      "firing",
    );
    expect(
      parseAlert({ text: ":large_green_circle: All clear", ts: "1700000000" })?.state,
    ).toBe("resolved");
  });

  it("distinguishes extraction vs parse kind, defaults to other", () => {
    expect(parseAlert({ text: "Extraction lag high", ts: "1" })?.kind).toBe("extraction");
    expect(parseAlert({ text: "Parsing error encountered", ts: "1" })?.kind).toBe("parse");
    expect(parseAlert({ text: "Disk usage warning", ts: "1" })?.kind).toBe("other");
  });

  it("defaults state to firing when no marker present", () => {
    expect(parseAlert({ text: "Generic alert with no marker", ts: "1" })?.state).toBe("firing");
  });

  it("uses the first non-empty line as the name", () => {
    const alert = parseAlert({ text: "\n\n  Real title here  \nbody line", ts: "1700000000" });
    expect(alert?.name).toBe("Real title here");
  });

  it("returns null for empty / whitespace-only text", () => {
    expect(parseAlert({ text: "", ts: "1700000000" })).toBeNull();
    expect(parseAlert({ text: "   \n  ", ts: "1700000000" })).toBeNull();
  });

  it("converts Slack ts (seconds.micros) to ISO", () => {
    const alert = parseAlert({ text: "[FIRING] x", ts: "1700000000.123456" });
    expect(alert?.firedAt).toBe("2023-11-14T22:13:20.123Z");
  });
});

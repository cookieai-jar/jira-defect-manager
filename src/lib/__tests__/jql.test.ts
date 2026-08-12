import { describe, it, expect } from "vitest";
import { stripDynamicClauses, extractMatchTokens } from "@/lib/jql";

describe("stripDynamicClauses", () => {
  it("removes ORDER BY", () => {
    expect(stripDynamicClauses("project = INT ORDER BY created DESC")).toBe("project = INT");
  });

  it("removes statusCategory and status filters", () => {
    expect(
      stripDynamicClauses("project = INT AND statusCategory != Done ORDER BY updated DESC"),
    ).toBe("project = INT");
    expect(stripDynamicClauses('project = INT AND status = "In Progress"')).toBe("project = INT");
  });

  it("removes top-level date filters", () => {
    expect(stripDynamicClauses("project = INT AND created >= -30d")).toBe("project = INT");
  });

  it("removes parenthesized date clauses (no nested parens)", () => {
    expect(
      stripDynamicClauses("project = INT AND (created >= -30d AND updated >= -7d)"),
    ).toBe("project = INT");
  });
});

describe("extractMatchTokens", () => {
  it("pulls values out of an in(...) clause", () => {
    const tokens = extractMatchTokens('"Customer[X]" in ("JPMorgan Chase", "Acme")');
    expect(tokens).toContain("JPMorgan Chase");
    expect(tokens).toContain("Acme");
  });

  it("pulls the RHS of = and ~", () => {
    expect(extractMatchTokens('summary ~ "pagination"')).toContain("pagination");
  });

  it("drops single-character tokens and dedupes", () => {
    const tokens = extractMatchTokens('a = "x" AND b in ("x", "yy")');
    expect(tokens).not.toContain("x"); // length 1 filtered
    expect(tokens.filter((t) => t === "yy")).toHaveLength(1);
  });
});

import { describe, it, expect } from "vitest";
import {
  bucketize,
  buildCategorizationPrompt,
  fingerprintIssues,
  normalizeCategory,
  type CategoryAssignment,
} from "../defect-categorize-core";
import { categorizeDefects, type CompletionFn } from "../defect-categorize";
import type { JiraIssue } from "@/types/triage";

function issue(key: string, over: Partial<JiraIssue> = {}): JiraIssue {
  return {
    key,
    summary: `summary ${key}`,
    status: "Backlog",
    statusCategory: "new",
    priority: "P2",
    issueType: "Bug",
    reporter: null,
    assignee: null,
    created: "2026-02-01T00:00:00.000Z",
    updated: "2026-03-01T00:00:00.000Z",
    resolved: null,
    labels: [],
    components: ["Integrations"],
    url: `https://x/${key}`,
    description: null,
    comments: [],
    parent: null,
    customers: [],
    targetedMonth: null,
    ...over,
  };
}

describe("fingerprintIssues", () => {
  it("is stable regardless of order", () => {
    const a = [issue("EAC-1"), issue("EAC-2")];
    const b = [issue("EAC-2"), issue("EAC-1")];
    expect(fingerprintIssues(a)).toBe(fingerprintIssues(b));
  });
  it("changes when a ticket's updated timestamp changes", () => {
    const a = [issue("EAC-1")];
    const b = [issue("EAC-1", { updated: "2026-04-01T00:00:00.000Z" })];
    expect(fingerprintIssues(a)).not.toBe(fingerprintIssues(b));
  });
  it("changes when the count changes", () => {
    const a = [issue("EAC-1")];
    const b = [issue("EAC-1"), issue("EAC-2")];
    expect(fingerprintIssues(a)).not.toBe(fingerprintIssues(b));
  });
});

describe("normalizeCategory", () => {
  it("passes through known keys and defaults unknown to other", () => {
    expect(normalizeCategory("auth")).toBe("auth");
    expect(normalizeCategory("AUTH")).toBe("auth");
    expect(normalizeCategory("not-a-real-cat")).toBe("other");
    expect(normalizeCategory(null)).toBe("other");
  });
});

describe("bucketize", () => {
  it("counts every issue exactly once and defaults missing to other", () => {
    const issues = [issue("EAC-1"), issue("EAC-2"), issue("EAC-3")];
    const assignments: CategoryAssignment[] = [
      { issueKey: "EAC-1", category: "auth" },
      { issueKey: "EAC-2", category: "auth" },
      // EAC-3 unassigned -> other
    ];
    const result = bucketize(issues, assignments, "fp", "2026-06-01T00:00:00.000Z");
    expect(result.total).toBe(3);
    const summed = result.categories.reduce((n, c) => n + c.count, 0);
    expect(summed).toBe(3);
    const auth = result.categories.find((c) => c.key === "auth");
    expect(auth?.count).toBe(2);
    const other = result.categories.find((c) => c.key === "other");
    expect(other?.issueKeys).toEqual(["EAC-3"]);
  });
  it("omits empty buckets and pins other last", () => {
    const issues = [issue("EAC-1"), issue("EAC-2")];
    const result = bucketize(
      issues,
      [
        { issueKey: "EAC-1", category: "performance" },
        { issueKey: "EAC-2", category: "bogus" },
      ],
      "fp",
      "t",
    );
    expect(result.categories.map((c) => c.key)).toEqual(["performance", "other"]);
  });
});

describe("buildCategorizationPrompt", () => {
  it("lists the taxonomy keys and every ticket", () => {
    const prompt = buildCategorizationPrompt([
      issue("EAC-1", { summary: "Okta extraction fails" }),
    ]);
    expect(prompt).toContain("extraction-sync");
    expect(prompt).toContain("EAC-1: Okta extraction fails");
    expect(prompt).toContain("assignments");
  });
});

describe("categorizeDefects (injected completion)", () => {
  it("batches, aggregates, and stamps fingerprint + time", async () => {
    const issues = Array.from({ length: 3 }, (_, i) => issue(`EAC-${i + 1}`));
    const completion = (async () => ({
      assignments: [
        { issueKey: "EAC-1", category: "auth" },
        { issueKey: "EAC-2", category: "performance" },
        { issueKey: "EAC-3", category: "auth" },
      ],
    })) as unknown as CompletionFn;
    const result = await categorizeDefects(issues, {
      completion,
      model: "test-model",
      now: "2026-06-01T00:00:00.000Z",
    });
    expect(result.fingerprint).toBe(fingerprintIssues(issues));
    expect(result.categorizedAt).toBe("2026-06-01T00:00:00.000Z");
    expect(result.categories.find((c) => c.key === "auth")?.count).toBe(2);
  });
  it("survives a batch that throws (its tickets fall into other)", async () => {
    const issues = [issue("EAC-1")];
    const completion = (async () => {
      throw new Error("overloaded");
    }) as unknown as CompletionFn;
    const result = await categorizeDefects(issues, {
      completion,
      model: "test-model",
      now: "t",
    });
    expect(result.total).toBe(1);
    expect(result.categories.find((c) => c.key === "other")?.count).toBe(1);
  });
});

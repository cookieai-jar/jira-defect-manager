import type { JiraIssue } from "@/types/triage";

/**
 * Pure logic for the All Defects categorization gadget — taxonomy, fingerprint,
 * prompt construction, response parsing, and bucketing. Kept free of any
 * Anthropic/db import so it can be unit-tested and imported by the client
 * (the gadget computes the current fingerprint to detect stale analysis).
 */

/** Fixed defect taxonomy so the distribution is stable across runs. */
export const DEFECT_CATEGORIES = [
  { key: "extraction-sync", name: "Extraction / sync failure" },
  { key: "parsing-transform", name: "Parsing / transformation" },
  { key: "auth", name: "Authentication / authorization" },
  { key: "data-accuracy", name: "Data accuracy / mapping" },
  { key: "performance", name: "Performance / scalability" },
  { key: "configuration", name: "Configuration / setup" },
  { key: "api-limits", name: "API error / rate limiting" },
  { key: "ui-ux", name: "UI / UX" },
  { key: "other", name: "Other / uncategorized" },
] as const;

export type DefectCategoryKey = (typeof DEFECT_CATEGORIES)[number]["key"];

const CATEGORY_KEYS = new Set<string>(DEFECT_CATEGORIES.map((c) => c.key));
const NAME_BY_KEY = new Map<string, string>(DEFECT_CATEGORIES.map((c) => [c.key, c.name]));

export interface DefectCategoryBucket {
  key: string;
  name: string;
  count: number;
  issueKeys: string[];
}

export interface DefectCategorization {
  categorizedAt: string;
  /** Fingerprint of the issue set this categorization was computed from. */
  fingerprint: string;
  total: number;
  categories: DefectCategoryBucket[];
}

/** One model assignment: a ticket key mapped to a category key. */
export interface CategoryAssignment {
  issueKey: string;
  category: string;
}

/**
 * PURE. Stable fingerprint of an issue set (sorted key+updated pairs, FNV-1a).
 * Used to tell whether a persisted categorization still matches the live data.
 */
export function fingerprintIssues(issues: Pick<JiraIssue, "key" | "updated">[]): string {
  const parts = issues
    .map((i) => `${i.key}:${i.updated}`)
    .sort()
    .join("|");
  let h = 0x811c9dc5;
  for (let i = 0; i < parts.length; i++) {
    h ^= parts.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0") + ":" + issues.length;
}

/** Normalize a model-returned category to a known key, defaulting to "other". */
export function normalizeCategory(raw: string | null | undefined): DefectCategoryKey {
  if (!raw) return "other";
  const norm = raw.toLowerCase().trim();
  if (CATEGORY_KEYS.has(norm)) return norm as DefectCategoryKey;
  return "other";
}

/**
 * PURE. Fold model assignments into the fixed-taxonomy buckets. Every issue is
 * counted exactly once; unknown/missing assignments fall into "other". Buckets
 * are returned in taxonomy order, then re-sorted by count descending with
 * "other" pinned last for display.
 */
export function bucketize(
  issues: Pick<JiraIssue, "key">[],
  assignments: CategoryAssignment[],
  fingerprint: string,
  categorizedAt: string,
): DefectCategorization {
  const byKey = new Map(assignments.map((a) => [a.issueKey, normalizeCategory(a.category)]));
  const buckets = new Map<string, string[]>();
  for (const c of DEFECT_CATEGORIES) buckets.set(c.key, []);
  for (const issue of issues) {
    const cat = byKey.get(issue.key) ?? "other";
    buckets.get(cat)!.push(issue.key);
  }
  const categories: DefectCategoryBucket[] = DEFECT_CATEGORIES.map((c) => ({
    key: c.key,
    name: c.name,
    count: buckets.get(c.key)!.length,
    issueKeys: buckets.get(c.key)!,
  }))
    .filter((b) => b.count > 0)
    .sort((a, b) => {
      if (a.key === "other") return 1;
      if (b.key === "other") return -1;
      return b.count - a.count;
    });
  return { categorizedAt, fingerprint, total: issues.length, categories };
}

export function categoryName(key: string): string {
  return NAME_BY_KEY.get(key) ?? key;
}

/** PURE. Build the LLM user prompt for one batch of tickets. */
export function buildCategorizationPrompt(
  issues: Pick<JiraIssue, "key" | "summary" | "components" | "labels">[],
): string {
  const taxonomy = DEFECT_CATEGORIES.map((c) => `- ${c.key}: ${c.name}`).join("\n");
  const tickets = issues
    .map((i) => {
      const ctx = [i.components.join("/"), i.labels.slice(0, 6).join(",")]
        .filter(Boolean)
        .join(" · ");
      return `${i.key}: ${i.summary}${ctx ? `  [${ctx}]` : ""}`;
    })
    .join("\n");
  return [
    "Categorize each defect ticket into exactly one of these categories:",
    taxonomy,
    "",
    "Tickets:",
    tickets,
    "",
    'Return JSON: {"assignments":[{"issueKey":"EAC-123","category":"extraction-sync"}, ...]}.',
    "Use the category KEY (left of the colon). Every ticket must appear exactly once.",
    'If none fit, use "other".',
  ].join("\n");
}

export const CATEGORIZATION_SYSTEM =
  "You are a triage assistant that classifies software defect tickets for a data-integration " +
  "platform (Veza) into a fixed taxonomy. Judge by the primary failure mode. Respond with JSON only.";

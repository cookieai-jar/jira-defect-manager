import type { JiraIssue } from "@/types/triage";
import { defaultModel, jsonCompletion } from "./anthropic";
import {
  buildCategorizationPrompt,
  bucketize,
  CATEGORIZATION_SYSTEM,
  fingerprintIssues,
  type CategoryAssignment,
  type DefectCategorization,
} from "./defect-categorize-core";

/**
 * The completion function the categorizer depends on. Defaults to the real
 * Anthropic-backed `jsonCompletion`, but is injectable so orchestration can be
 * unit-tested without any network calls.
 */
export type CompletionFn = <T>(opts: {
  model: string;
  system: string;
  user: string;
  systemCacheable?: boolean;
  maxTokens?: number;
}) => Promise<T>;

const BATCH_SIZE = 40;

/**
 * Categorize a set of defect tickets into the fixed taxonomy. Batches the
 * tickets, calls the model per batch, and folds the assignments into buckets.
 * A batch that fails is skipped (its tickets fall into "other"), so a single
 * overloaded call can't sink the whole run.
 */
export async function categorizeDefects(
  issues: JiraIssue[],
  opts: { completion?: CompletionFn; model?: string; now: string } = { now: "" },
): Promise<DefectCategorization> {
  const completion = opts.completion ?? jsonCompletion;
  const model = opts.model ?? defaultModel();
  const fingerprint = fingerprintIssues(issues);

  const batches: JiraIssue[][] = [];
  for (let i = 0; i < issues.length; i += BATCH_SIZE) {
    batches.push(issues.slice(i, i + BATCH_SIZE));
  }

  const assignments: CategoryAssignment[] = [];
  const results = await Promise.all(
    batches.map(async (batch, idx) => {
      try {
        const out = await completion<{ assignments?: CategoryAssignment[] }>({
          model,
          system: CATEGORIZATION_SYSTEM,
          systemCacheable: true,
          user: buildCategorizationPrompt(batch),
          maxTokens: 4096,
        });
        return out.assignments ?? [];
      } catch (err) {
        console.error(`[defect-categorize] batch ${idx} failed:`, err);
        return [] as CategoryAssignment[];
      }
    }),
  );
  for (const r of results) assignments.push(...r);

  return bucketize(issues, assignments, fingerprint, opts.now);
}

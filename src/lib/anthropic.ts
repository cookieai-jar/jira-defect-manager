import Anthropic, { APIError } from "@anthropic-ai/sdk";

let _client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("Missing ANTHROPIC_API_KEY in .env.local");
  }
  // SDK retries 408/409/429/5xx with exponential backoff. Crank it up so a
  // sync survives sustained overload windows (Anthropic returns 529 during
  // capacity spikes — it's transient and retryable).
  _client = new Anthropic({ apiKey, maxRetries: 6 });
  return _client;
}

function isRetryableOverload(err: unknown): boolean {
  if (err instanceof APIError) {
    if (err.status === 529 || err.status === 503 || err.status === 429) return true;
    // Some SDK versions surface this in error.error.type
    const type = (err as unknown as { error?: { type?: string } }).error?.type;
    if (type === "overloaded_error" || type === "api_error") return true;
  }
  return false;
}

async function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function defaultModel(): string {
  return process.env.ANTHROPIC_MODEL || "claude-opus-4-7";
}

/**
 * Run a single JSON-shaped completion. We instruct the model to return strict
 * JSON inside a ```json fence and parse the first fenced block we find.
 */
export async function jsonCompletion<T>(opts: {
  model: string;
  system: string;
  user: string;
  systemCacheable?: boolean;       // cache the system prompt across calls
  maxTokens?: number;
}): Promise<T> {
  const system = opts.systemCacheable
    ? [
        {
          type: "text" as const,
          text: opts.system,
          cache_control: { type: "ephemeral" as const },
        },
      ]
    : opts.system;
  // Defense in depth: the SDK already retries, but stack another layer on top
  // for overload windows that exceed its internal retry budget. Long, jittered
  // backoff because 529s mean the upstream is genuinely saturated.
  const MAX_EXTRA_RETRIES = 4;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= MAX_EXTRA_RETRIES; attempt++) {
    try {
      const msg = await anthropic().messages.create({
        model: opts.model,
        max_tokens: opts.maxTokens ?? 4096,
        system: system as never,
        messages: [{ role: "user", content: opts.user }],
      });
      const text = msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      if (msg.stop_reason === "max_tokens") {
        throw new Error(
          `Model output truncated by max_tokens (${opts.maxTokens ?? 4096}). Increase the limit or shorten the request. Got ${text.length} chars.`,
        );
      }
      return parseJson<T>(text);
    } catch (err) {
      lastErr = err;
      if (!isRetryableOverload(err) || attempt === MAX_EXTRA_RETRIES) {
        throw err;
      }
      // Exponential backoff with jitter: ~5s, ~10s, ~20s, ~40s.
      const baseMs = 5000 * Math.pow(2, attempt);
      const jitterMs = Math.floor(Math.random() * 2000);
      const waitMs = baseMs + jitterMs;
      console.warn(
        `[anthropic] overload (${err instanceof APIError ? err.status : "?"}); waiting ${Math.round(waitMs / 1000)}s before retry ${attempt + 1}/${MAX_EXTRA_RETRIES}`,
      );
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

function parseJson<T>(text: string): T {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenceMatch ? fenceMatch[1] : text).trim();
  try {
    return JSON.parse(body) as T;
  } catch (err) {
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(body.slice(start, end + 1)) as T;
      } catch {
        /* fallthrough */
      }
    }
    throw new Error(
      `Model did not return parseable JSON: ${err instanceof Error ? err.message : String(err)}\n---\n${text.slice(0, 600)}`,
    );
  }
}

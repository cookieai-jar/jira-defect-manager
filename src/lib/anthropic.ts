import Anthropic from "@anthropic-ai/sdk";

let _client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("Missing ANTHROPIC_API_KEY in .env.local");
  }
  _client = new Anthropic({ apiKey });
  return _client;
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
  return parseJson<T>(text);
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

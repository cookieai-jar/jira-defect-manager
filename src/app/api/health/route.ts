import { NextResponse } from "next/server";
import { pingJira } from "@/lib/jira";

export async function GET() {
  const jira = await pingJira();
  const anthropic = process.env.ANTHROPIC_API_KEY
    ? { ok: true as const }
    : { ok: false as const, error: "ANTHROPIC_API_KEY not set" };
  return NextResponse.json({
    jira,
    anthropic,
    env: {
      jiraBaseUrl: process.env.JIRA_BASE_URL ?? null,
      jiraEmail: process.env.JIRA_EMAIL ?? null,
      model: process.env.ANTHROPIC_MODEL ?? "claude-opus-4-7",
    },
  });
}

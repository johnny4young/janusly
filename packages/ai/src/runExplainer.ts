/**
 * Run-explainer — converts a (run, events) pair into a human-readable
 * narrative, either via the configured LLM provider when an `LlmClient` is
 * supplied or via a deterministic fallback when one isn't.
 *
 * This is the canonical example of Janusly's AI-fallback contract: every AI
 * surface must succeed even when no API key is configured, by returning
 * `{ mode: "fallback", aiError? }` and a useful local answer. Don't break
 * that contract — see AGENTS.md for the project-wide invariant.
 *
 * Used by:
 * - `apps/api/src/index.ts` — `POST /ai/explain-run` calls `explainRun(...)`
 *   and surfaces the response (with `aiError` when present) to the AI Studio.
 *
 * Invariants:
 * - The LLM call is wrapped in try/catch; any thrown error becomes a
 *   `mode: "fallback"` response with `aiError` set to the error message.
 *   New error sources from the abstraction (unknown provider, missing key
 *   for a per-call override) flow through the same try/catch.
 * - `fallbackExplainRun` runs without an LLM client and never throws.
 * - The prompt never includes secrets — the caller must redact `events`
 *   payloads before passing them in (the engine already does this via
 *   `redactValues`, ENG-001).
 */

import type { LlmClient } from "./llm-client";

/** Input shared by both `explainRun` (AI mode) and `fallbackExplainRun`. */
export type RunExplanationInput = {
  run: unknown;
  events: unknown[];
  question?: string;
};

/** Response shape returned by `explainRun`. `mode` indicates whether the
 * answer came from the LLM or the deterministic fallback; `aiError` is set
 * only when AI mode was attempted and failed. `provider` carries the
 * resolved provider name (registry key) on AI-mode success so audit
 * payloads can record cross-vendor cohort signal (ENG-005/ENG-006). */
export type RunExplanation = {
  answer: string;
  mode: "ai" | "fallback";
  model?: string;
  provider?: string;
  aiError?: string;
};

/**
 * Build the prompt sent to the LLM for run explanation. Pure function — no
 * side effects — so the same input always yields the same prompt.
 */
export function buildRunExplanationPrompt(input: RunExplanationInput) {
  return `You are an AI workflow observability assistant.

Explain the workflow run in clear, concise terms.
Focus on:
- what happened
- why decisions were made
- failures/retries/rollbacks
- what the user should do next

User question:
${input.question ?? "Explain this run"}

Run:
${JSON.stringify(input.run, null, 2)}

Events:
${JSON.stringify(input.events, null, 2)}

Return a concise answer with bullet points.`;
}

/**
 * Explain a workflow run end-to-end. Uses the supplied `LlmClient` when
 * provided; otherwise (or on error) returns the deterministic fallback
 * narrative with `mode: "fallback"`.
 *
 * Called from `POST /ai/explain-run` in `apps/api/src/index.ts`. The route
 * surfaces `aiError` to the UI so the user sees why we degraded.
 *
 * @param model Optional model override — bare model id or `"<provider>/<model>"` spec.
 *   When omitted, the configured default model is used.
 */
export async function explainRun({
  llm,
  run,
  events,
  question,
  model,
}: RunExplanationInput & {
  llm?: LlmClient | null;
  model?: string;
}): Promise<RunExplanation> {
  if (!llm) {
    return {
      answer: fallbackExplainRun({ run, events, question }),
      mode: "fallback",
    };
  }

  try {
    const result = await llm.generateText({
      prompt: buildRunExplanationPrompt({ run, events, question }),
      modelHint: model,
    });
    return {
      answer: result.text,
      mode: "ai",
      model: result.model,
      provider: result.provider,
    };
  } catch (error) {
    return {
      answer: fallbackExplainRun({ run, events, question }),
      mode: "fallback",
      aiError: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Deterministic fallback narrative — a one-paragraph summary derived from
 * counting event categories (failures, retries, decisions, rollbacks,
 * skipped). Pure, never throws. Used both as the standalone answer when no
 * LLM client is available AND as the safety net inside `explainRun`'s
 * catch block.
 */
export function fallbackExplainRun(input: RunExplanationInput): string {
  const events = input.events as Array<{ type?: string }>;
  const failed = events.filter((event) => event.type?.includes("failed"));
  const retries = events.filter((event) => event.type?.includes("retry"));
  const decisions = events.filter((event) => event.type === "decision.made");
  const rollbacks = events.filter((event) => event.type?.startsWith("rollback."));
  const skipped = events.filter((event) => event.type === "node.skipped");

  return [
    `Run summary: ${events.length} events observed.`,
    decisions.length ? `Decisions made: ${decisions.length}.` : "No routing decisions were recorded.",
    retries.length ? `Retries scheduled/executed: ${retries.length}.` : "No retries were recorded.",
    failed.length ? `Failures detected: ${failed.length}.` : "No failures were detected.",
    skipped.length ? `Nodes skipped by edge conditions: ${skipped.length}.` : "All reachable nodes ran.",
    rollbacks.length ? `Rollback activity detected: ${rollbacks.length}.` : "No rollback activity detected.",
  ].join("\n");
}

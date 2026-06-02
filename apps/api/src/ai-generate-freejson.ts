/**
 * Free-JSON workflow generation for `/ai/generate-workflow`.
 *
 * Instead of the provider's constrained structured-output path
 * (`llm.generateObject`), the model emits the workflow as JSON *text*
 * which is parsed + Zod-validated server-side. An A/B eval showed this is
 * strictly better on Haiku across reliability, judge-quality, and cost —
 * constrained decoding guarantees JSON shape but not graph validity, so
 * ~30% of constrained outputs failed `validateWorkflow`. Free-JSON also
 * removes the provider `oneOf` blocker and structured-output grammar cap.
 *
 * Used by `apps/api/src/routes/ai-routes.ts` when
 * `org_configs.ai.generationMode === "free_json"` (the default). The
 * legacy `constrained` mode keeps the `generateObject` path.
 *
 * Invariants:
 * - Allowed node shapes are unchanged: the parsed text is validated
 *   against `AiGenerationWorkflowSchema` (the same 11-branch subset the
 *   constrained path uses), so this is a pure mechanism swap. The route's
 *   downstream `promoteNoopPlaceholders` + `sanitizeAiWorkflow` remain the
 *   authoritative correctness gate.
 * - Never silently degrades to a wrong workflow: a parse/validation
 *   failure on every attempt throws, and the route's existing try/catch
 *   degrades to the deterministic fallback per the AI-fallback contract.
 */

import { type LlmClient } from "@janusly/ai";
import { type Workflow } from "@janusly/shared";

import { AiGenerationWorkflowSchema } from "./ai-schemas";

/** Max generation attempts before degrading to fallback (blind re-sample). */
export const FREE_JSON_MAX_ATTEMPTS = 2;

/**
 * Pull a JSON object out of a model reply. `responseFormat: "json"` makes
 * Anthropic return bare JSON in the common case, but defensively strip
 * markdown fences and slice to the outermost `{...}` so a stray prose
 * wrapper doesn't fail the parse.
 */
export function extractJsonObject(text: string): string {
  let t = text.trim();
  t = t.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first >= 0 && last > first) return t.slice(first, last + 1);
  return t;
}

/**
 * Parse + validate a model's JSON text into a `Workflow`, or `null` on any
 * failure (malformed JSON or shape outside the generation subset). Mirrors
 * the `suggest-improvement` blob-parse pattern in `ai-routes.ts`.
 */
export function parseGeneratedWorkflow(text: string): Workflow | null {
  let raw: unknown;
  try {
    raw = JSON.parse(extractJsonObject(text));
  } catch {
    return null;
  }
  const parsed = AiGenerationWorkflowSchema.safeParse(raw);
  if (!parsed.success) return null;
  // The AI generation subset's discriminated-union node configs are strict
  // subsets of the engine's loose `config: Record<string, unknown>`, so the
  // inferred shape structurally satisfies `Workflow`. `sanitizeAiWorkflow`
  // re-validates through the strict engine gate downstream.
  return parsed.data as unknown as Workflow;
}

export type FreeJsonGenerationResult = {
  workflow: Workflow;
  model: string;
  provider: string;
  attempts: number;
};

const RETRY_NUDGE =
  "\n\nYour previous reply was not a valid workflow. Return ONLY the JSON workflow object — no prose, no markdown fences.";

/**
 * Generate a workflow via the free-JSON path with retry-on-parse-fail.
 * Returns the first parseable+valid result; throws after
 * `FREE_JSON_MAX_ATTEMPTS` so the caller's fallback path engages.
 */
export async function generateWorkflowFreeJson(
  llm: LlmClient,
  system: string,
  prompt: string,
  modelHint: string | undefined,
  context: { orgId: string; userId?: string },
): Promise<FreeJsonGenerationResult> {
  let lastModel = "";
  let lastProvider = "";
  for (let attempt = 1; attempt <= FREE_JSON_MAX_ATTEMPTS; attempt++) {
    const result = await llm.generateText({
      system,
      prompt: attempt === 1 ? prompt : prompt + RETRY_NUDGE,
      responseFormat: "json",
      modelHint,
      context,
    });
    lastModel = result.model;
    lastProvider = result.provider;
    const workflow = parseGeneratedWorkflow(result.text ?? "");
    if (workflow) {
      return { workflow, model: result.model, provider: result.provider, attempts: attempt };
    }
  }
  throw new Error(
    `free-JSON generation produced no valid workflow after ${FREE_JSON_MAX_ATTEMPTS} attempts (model=${lastModel || "unknown"}, provider=${lastProvider || "unknown"})`,
  );
}

/**
 * AI helper that proposes a workflow patch given a failing-run context.
 * Pattern matches `runExplainer.ts` — accepts an `LlmClient` (nullable
 * to support the fallback path), a workflow snapshot, the failing
 * node id, the error envelope, and the recent run events; calls
 * `llm.generateObject({ schema })` with a structured-output schema the
 * caller owns; returns `{ mode, suggestedWorkflow, rationale, aiError? }`.
 *
 * The structured-output schema is owned by the API route, not this
 * helper — same pattern as `explainRun`, where the route assembles
 * the context and calls the helper. Keeps `packages/ai` schema-agnostic.
 *
 * Hard contract per AGENTS.md AI-fallback invariant: this helper
 * NEVER throws. Any LLM failure (no client, quota, network, schema
 * mismatch from the model) becomes a `mode: "fallback"` response
 * with the original workflow returned untouched and a rationale
 * explaining what to do manually. The route adds a safe-parse step
 * on AI-mode output to catch mismatches against the engine's strict
 * `WorkflowSchema`.
 *
 * Used by `apps/api/src/index.ts:POST /ai/patch-workflow`.
 */

import type { LlmClient, LlmGenerateObjectInput } from "./llm-client";

/** Result returned by `suggestWorkflowPatch`. */
export type PatchSuggestion = {
  mode: "ai" | "fallback";
  /** Raw JSON; the API route runs `WorkflowSchema.safeParse` + `sanitizeAiWorkflow` before returning. */
  suggestedWorkflow: unknown;
  /** Free-text paragraph explaining what changed and why. Surfaces in the recovery dialog. */
  rationale: string;
  model?: string;
  provider?: string;
  /** Set only when AI mode was attempted and degraded to fallback. */
  aiError?: string;
};

/** Run-event payload subset used by the prompt builder. Looser than the engine's `RunEvent` so test fixtures stay simple. */
export type RunEventForPrompt = {
  type: string;
  nodeId?: string | null;
  payload?: unknown;
  createdAt?: string | Date | null;
};

/** Schema-shape contract the route hands the helper. Both fields required. */
export type PatchEnvelopeSchemaResult = {
  workflow: unknown;
  rationale: string;
};

export type SuggestWorkflowPatchInput = {
  llm: LlmClient | null;
  /**
   * Structured-output Zod schema that produces `{ workflow, rationale }`.
   * The route owns this — keeps `packages/ai` schema-agnostic. The
   * `FlexibleSchema<PatchEnvelopeSchemaResult>` type lines up with what
   * `LlmClient.generateObject` accepts.
   */
  envelopeSchema: LlmGenerateObjectInput<PatchEnvelopeSchemaResult>["schema"];
  /** Original (failing) workflow snapshot from `dead_letters.workflowJson`. */
  workflow: unknown;
  /** Id of the failing node; used in the prompt to focus the patch. */
  failedNodeId: string;
  /** Error envelope as persisted (already key-redacted by safe-persist). */
  errorJson: unknown;
  /** Recent run events; the helper truncates to `RUN_EVENT_PROMPT_CAP`. */
  runEvents: RunEventForPrompt[];
  /** Optional model override (`"<provider>/<model>"` form for cross-provider). */
  model?: string;
};

/** Maximum number of run events embedded in the prompt. Keeps the model from drowning in noisy logs. */
export const RUN_EVENT_PROMPT_CAP = 20;

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9_\-.]{16,}\b/gi,
  /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g,
];

const FALLBACK_RATIONALE_NO_LLM =
  "AI is unavailable right now. The original workflow is unchanged — open the failing node and adjust its config (retry, timeout, URL, secret reference) before re-running.";

const SYSTEM_PROMPT = `You are Janusly's failure-recovery agent. You are given a workflow that just failed, the id of the failing node, the error envelope (already redacted of secret values), and recent run events.

Produce a structured patch that fixes the cause. Rules:
- Output a complete updated Workflow object (every node, every edge), NOT a delta.
- Keep node ids stable. Keep edge from/to/condition stable unless an edge change is the fix.
- Modify only the failing node's config when possible (e.g. fix a typo in a URL, swap a literal token to \`{{secret.NAME}}\` / \`{{credential.NAME}}\` / \`{{env.NAME}}\` template reference, or change the HTTP method).
- Resilience fixes belong in \`config\` directly. When the failure is transient (5xx, network reset, timeout, body-cap exceeded), set the relevant resilience field on the failing node and reference the same change in the rationale:
  - \`config.retry: { maxAttempts: <2-5> }\` — for transient retryable failures (5xx, ECONNRESET, ETIMEDOUT). Pick a small integer; maxAttempts must be at least 2 because 1 means no retry. The engine fills sensible defaults for delay and backoff.
  - \`config.timeoutMs: <milliseconds>\` — when the failure is a timeout. Default is 30000 ms; raise modestly (60000-120000) rather than removing the bound.
  - \`config.maxResponseBytes: <bytes>\` — when the failure is a body-cap rejection. Default is 1048576 (1 MB); raise to 5242880 (5 MB) or 10485760 (10 MB) when the response is legitimately larger.
  - \`config.maxRedirects: <integer>\` — when the failure is a redirect-loop or insufficient redirects. Default is 5.
- Do NOT add unrelated nodes or remove existing nodes.
- Do NOT include any secret values verbatim.
- Provide a one-paragraph \`rationale\` explaining what you changed and why, written for a workflow operator (not a developer). When you set a resilience field, name the field and the value you chose so the operator can verify.`;

/**
 * Propose a workflow patch for a failed run. Never throws — every
 * failure path returns a `mode: "fallback"` response with the original
 * workflow and a rationale.
 */
export async function suggestWorkflowPatch(
  input: SuggestWorkflowPatchInput,
): Promise<PatchSuggestion> {
  const { llm, envelopeSchema, workflow, failedNodeId, errorJson, runEvents, model } = input;

  if (!llm) {
    return {
      mode: "fallback",
      suggestedWorkflow: workflow,
      rationale: FALLBACK_RATIONALE_NO_LLM,
    };
  }

  const promptEvents = runEvents.slice(0, RUN_EVENT_PROMPT_CAP).map((event) => ({
    type: event.type,
    nodeId: event.nodeId ?? null,
    payload: scrubPromptSecretShapes(event.payload ?? null),
    createdAt: event.createdAt instanceof Date ? event.createdAt.toISOString() : event.createdAt ?? null,
  }));

  const promptBody = JSON.stringify({
    workflow: scrubPromptSecretShapes(workflow),
    failedNodeId,
    errorJson: scrubPromptSecretShapes(errorJson),
    runEvents: promptEvents,
  });

  try {
    const result = await llm.generateObject<PatchEnvelopeSchemaResult>({
      // The caller's Zod schema goes through unchanged — the LLM client
      // forwards it to the provider's structured-output enforcement.
      schema: envelopeSchema,
      schemaName: "JanuslyWorkflowPatch",
      schemaDescription: "Proposed patch for a failing workflow plus a rationale.",
      system: SYSTEM_PROMPT,
      prompt: promptBody,
      modelHint: model,
    });
    const { workflow: suggestedWorkflow, rationale } = result.object;
    return {
      mode: "ai",
      suggestedWorkflow,
      rationale,
      model: result.model,
      provider: result.provider,
    };
  } catch (error) {
    return {
      mode: "fallback",
      suggestedWorkflow: workflow,
      rationale: `${FALLBACK_RATIONALE_NO_LLM} (Reason: ${error instanceof Error ? error.message : String(error)})`,
      aiError: error instanceof Error ? error.message : String(error),
    };
  }
}

function scrubPromptSecretShapes(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return scrubString(value);
  if (!value || typeof value !== "object") return value;

  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (value instanceof Date) {
    seen.delete(value);
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    const scrubbed = value.map((item) => scrubPromptSecretShapes(item, seen));
    seen.delete(value);
    return scrubbed;
  }

  const scrubbed = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      scrubPromptSecretShapes(item, seen),
    ]),
  );
  seen.delete(value);
  return scrubbed;
}

function scrubString(value: string): string {
  let output = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    output = output.replace(pattern, "[redacted]");
  }
  return output;
}

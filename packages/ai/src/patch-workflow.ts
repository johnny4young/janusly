/**
 * AI helper that proposes a config patch for a failing node.
 *
 * Accepts an `LlmClient` (nullable for the fallback path), a workflow
 * snapshot, the failing node id, the error envelope, and the recent run
 * events. Calls `llm.generateObject({ schema })` with a structured-output
 * schema the route owns — one concrete envelope per failing-node type
 * (http / tool / agent / generic), all of shape `{ patchedConfig,
 * rationale }`. The LLM emits ONLY the patched config for the failing
 * node (not a full workflow), and the route composes the suggested
 * workflow server-side by shallow-merging the patched config onto the
 * original snapshot.
 *
 * Why per-type envelopes: a multi-branch discriminated union compiles
 * to JSON Schema `oneOf`, which OpenAI strict mode rejects outright and
 * Anthropic's grammar cap chokes on once you add resilience optionals.
 * One concrete envelope per call sidesteps both.
 *
 * The structured-output schema is owned by the API route, not this
 * helper — same pattern as `explainRun`. Keeps `packages/ai`
 * schema-agnostic and lets the route dispatch by failing-node type at
 * request time.
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

/**
 * Result returned by `suggestWorkflowPatch`.
 *
 * On `mode: "ai"`, `suggestedWorkflow` is the LLM's structured-output
 * envelope as parsed by the route's per-type schema — a
 * `{ patchedConfig, rationale }` shape, NOT a full workflow. The route
 * is responsible for composing the full workflow by merging the patched
 * config into the original snapshot before the dialog ever sees it.
 *
 * On `mode: "fallback"`, `suggestedWorkflow` is the original (failing)
 * workflow returned untouched so the dialog can render a "no changes"
 * diff and disable Apply.
 *
 * Either way, the API route normalises this back to a full
 * `Workflow` shape before sending to the operator — the UI contract
 * never sees a `patchedConfig` envelope.
 */
export type PatchSuggestion = {
  mode: "ai" | "fallback";
  /**
   * `mode: "ai"` → `{ patchedConfig: Record<string, unknown>, rationale }` envelope.
   * `mode: "fallback"` → the original workflow snapshot, untouched.
   * The route reconciles into a full workflow before returning to the UI.
   */
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

/**
 * Schema-shape contract the route hands the helper. Both fields
 * required. The route picks one of several per-type envelopes (http /
 * tool / agent / generic) and the LLM emits a `patchedConfig` object
 * containing only the fields it wants changed on the failing node. The
 * helper itself stays type-loose at this boundary — the per-type
 * schemas live in `apps/api/src/ai-schemas.ts` and validate at parse
 * time, then the route filters null sentinel fields and merges the
 * patched config into the original workflow.
 */
export type PatchEnvelopeSchemaResult = {
  patchedConfig: Record<string, unknown>;
  rationale: string;
};

export type SuggestWorkflowPatchInput = {
  llm: LlmClient | null;
  /**
   * Structured-output Zod schema that produces `{ patchedConfig,
   * rationale }`. The route owns this — keeps `packages/ai`
   * schema-agnostic. The `FlexibleSchema<PatchEnvelopeSchemaResult>`
   * type lines up with what `LlmClient.generateObject` accepts. The
   * route picks a different concrete schema per failing-node type
   * (http / tool / agent / generic) so each LLM call sees a single
   * non-union envelope (works on Anthropic + OpenAI strict mode).
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

Produce a config patch for the failing node — NOT a full workflow.

Output shape (enforced by the structured-output schema you receive):
- \`patchedConfig\`: the fields you want changed on the failing node's config. Some typed envelopes require every known field to be present for provider strict mode; set unchanged fields to \`null\`. The system filters \`null\` before shallow-merging your patch onto the original config, so those fields are preserved. For generic record envelopes, include only the fields you're changing.
- \`rationale\`: a one-paragraph explanation written for a workflow operator (not a developer). When you set a resilience field, name the field and the value you chose so the operator can verify.

Rules:
- Patch ONLY the failing node. Common fixes:
  - Fix a typo in a URL.
  - Swap a literal token to a \`{{secret.NAME}}\` / \`{{credential.NAME}}\` / \`{{env.NAME}}\` template reference.
  - Change the HTTP method.
  - Change the agent's \`goal\`.
  - Change a tool's \`tool\` name.
- Resilience knobs go in \`patchedConfig\` directly when the failure is transient:
  - \`retry: { maxAttempts: <2-5> }\` — for transient retryable failures (5xx, ECONNRESET, ETIMEDOUT). Pick a small integer; maxAttempts must be at least 2 because 1 means no retry. The engine fills sensible defaults for delay and backoff.
  - \`timeoutMs: <milliseconds>\` — when the failure is a timeout. Default is 30000 ms; raise modestly (60000-120000) rather than removing the bound.
  - \`maxResponseBytes: <bytes>\` — when the failure is a body-cap rejection. Default is 1048576 (1 MB); raise to 5242880 (5 MB) or 10485760 (10 MB) when the response is legitimately larger.
  - \`maxRedirects: <integer>\` — when the failure is a redirect-loop or insufficient redirects. Default is 5.
- Do NOT include any secret values verbatim.
- Do NOT emit a \`patchedConfig\` larger than the failing node's actual config — you patch one node, not the whole workflow.
- If you cannot find a sensible fix from the error and run events, return an empty \`patchedConfig: {}\` and explain in the rationale what the operator needs to inspect manually.`;

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
      // The route picks one concrete envelope per failing-node type so
      // the compiled JSON Schema has no `oneOf` keyword (works on
      // OpenAI strict mode AND fits Anthropic's grammar cap).
      schema: envelopeSchema,
      schemaName: "JanuslyWorkflowPatch",
      schemaDescription: "Patched config for the failing node plus a rationale.",
      system: SYSTEM_PROMPT,
      prompt: promptBody,
      modelHint: model,
    });
    // The result.object is the parsed envelope: `{ patchedConfig, rationale }`.
    // The route receives this verbatim as `suggestedWorkflow` and merges the
    // patched config into the original workflow before returning to the UI.
    return {
      mode: "ai",
      suggestedWorkflow: result.object,
      rationale: result.object.rationale,
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

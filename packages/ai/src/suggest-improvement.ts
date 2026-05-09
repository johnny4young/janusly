/**
 * AI helper that proposes 1-3 high-impact improvements to a workflow
 * snapshot. The operator sees them as switchable chips above a diff
 * view that compares the original workflow to each suggestion, and
 * picks one to manually save as a new version.
 *
 * Sister to `suggestWorkflowPatch` — same multi-suggestion shape, but
 * the input here is a workflow being authored (no failing node, no
 * DLQ row) and each suggestion is a FULL workflow snapshot rather than
 * a config-only patch. The route validates each suggested workflow
 * through the same `WorkflowSchema.safeParse` + `sanitizeAiWorkflow`
 * chain `/ai/generate-workflow` uses, then sorts survivors by
 * confidence desc.
 *
 * Hard contract per AGENTS.md AI-fallback invariant: this helper
 * NEVER throws. Any LLM failure (no client, quota, network, schema
 * mismatch from the model) becomes a `mode: "fallback"` response
 * with a single 0-confidence "other" suggestion that returns the
 * original workflow unchanged.
 *
 * The structured-output schema is owned by the API route, not this
 * helper — same pattern as `suggestWorkflowPatch` and `explainRun`.
 *
 * Used by `apps/api/src/index.ts:POST /ai/suggest-improvement`.
 */

import { scrubSecretShapes } from "@janusly/shared/src/error-signature";
import type { LlmClient, LlmGenerateObjectInput } from "./llm-client";

/** Closed approach-label set the model picks per suggestion. Mirrors the route's Zod enum. */
export type SuggestApproachLabel =
  | "add_retry"
  | "raise_timeout"
  | "swap_secret_ref"
  | "add_approval"
  | "add_observability"
  | "simplify"
  | "other";

/** Single suggestion as the LLM emits it — JSON-encoded workflow + metadata. The route parses, validates, and sanitises. */
export type SuggestImprovementItem = {
  /**
   * JSON-stringified workflow snapshot the LLM proposes. The route
   * runs `JSON.parse` then `WorkflowSchema.safeParse` +
   * `sanitizeAiWorkflow` before returning to the caller; suggestions
   * whose parse or schema validation fails are dropped, and when
   * none survive the route degrades to fallback. The shape choice
   * (JSON string vs typed inner schema) sidesteps the Anthropic
   * compiled-grammar cap that the bare `AiGenerationWorkflowSchema`
   * almost fills before the wrapper object adds further overhead;
   * see the envelope docstring in `apps/api/src/ai-schemas.ts`.
   */
  patchedWorkflowJson: string;
  /** One-paragraph operator-facing explanation of what changed and why. */
  rationale: string;
  /** Dominant intent of this suggestion — drives the chip on the dialog tab. */
  approachLabel: SuggestApproachLabel;
  /** Self-rated confidence 0-100. Pre-calibration; the dialog labels it as a self-rating. */
  confidence: number;
};

/**
 * Result returned by `suggestWorkflowImprovement`. The helper-boundary
 * contract is exclusively the array form — the route is responsible for
 * the back-compat `suggestedWorkflow`/`rationale` mirroring on the
 * response to the dialog.
 *
 * On `mode: "ai"`, `suggestions` carries 1-3 envelope items. The route
 * runs each through the engine's strict workflow validation, drops
 * failures, sorts survivors by confidence desc, and degrades to
 * fallback when none survive.
 *
 * On `mode: "fallback"`, `suggestions` is exactly one item:
 * `{ patchedWorkflowJson: <original-as-json>, rationale: <reason>, approachLabel: "other", confidence: 0 }`.
 */
export type SuggestImprovementResult = {
  mode: "ai" | "fallback";
  suggestions: SuggestImprovementItem[];
  model?: string;
  provider?: string;
  /** Set only when AI mode was attempted and degraded to fallback. */
  aiError?: string;
};

/** Helper for the route's fallback path — emits the input workflow as a JSON-stringified passthrough. */
function fallbackItem(workflow: unknown, rationale: string): SuggestImprovementItem {
  return {
    patchedWorkflowJson: JSON.stringify(workflow ?? {}),
    rationale,
    approachLabel: "other",
    confidence: 0,
  };
}

/**
 * Schema-shape contract the route hands the helper. The route owns the
 * Zod schema (`AiSuggestImprovementEnvelope` in
 * `apps/api/src/ai-schemas.ts`); the helper stays type-loose at this
 * boundary so `packages/ai` doesn't need to import the route's schemas.
 */
export type SuggestEnvelopeSchemaResult = {
  suggestions: SuggestImprovementItem[];
};

export type SuggestWorkflowImprovementInput = {
  llm: LlmClient | null;
  /**
   * Structured-output Zod schema that produces `{ suggestions:
   * Array<{ patchedWorkflowJson, rationale, approachLabel, confidence }> }`.
   * The route owns this — keeps `packages/ai` schema-agnostic. The
   * `FlexibleSchema<SuggestEnvelopeSchemaResult>` type lines up with
   * what `LlmClient.generateObject` accepts.
   */
  envelopeSchema: LlmGenerateObjectInput<SuggestEnvelopeSchemaResult>["schema"];
  /** Workflow snapshot the operator wants improved. */
  workflow: unknown;
  /**
   * Optional operator-supplied focus — what aspect to improve (e.g.
   * "add retry budgets", "tighten secret references"). When absent the
   * model picks the highest-impact angle on its own. Trimmed to 200
   * chars by the route before passing through.
   */
  focus?: string;
  /** Optional model override (`"<provider>/<model>"` form for cross-provider). */
  model?: string;
  /**
   * Telemetry context forwarded to `LlmClient.generateObject`. The
   * route owns this and threads `orgId` (always) and `workflowId`
   * (when the input workflow has a saved id) so the recorder can
   * write `metadata.workflowId` for the breakdown surface.
   */
  context?: LlmGenerateObjectInput<SuggestEnvelopeSchemaResult>["context"];
};

/** Maximum focus length the route accepts before trimming. */
export const SUGGEST_FOCUS_MAX = 200;

const FALLBACK_RATIONALE_NO_LLM =
  "AI is unavailable right now. The original workflow is returned unchanged — open the workflow in the editor and apply improvements (add retries, raise timeouts, swap literals to secret references) by hand.";

const SYSTEM_PROMPT = `You are Janusly's authoring assistant. You are given a Janusly workflow snapshot the operator is currently authoring (already redacted of secret values) and an optional \`focus\` hint of what they want to improve.

Produce 1-3 distinct high-impact improved workflows. The operator sees them as switchable diffs against the current workflow and applies one by hand if they like it. Return fewer than 3 when fewer changes are actually justified.

Output shape (enforced by the structured-output schema you receive):
- \`suggestions\`: an array of 1 to 3 items, ordered from most likely to help to least. Each item is:
  - \`patchedWorkflowJson\`: the FULL improved workflow encoded as a JSON STRING (call \`JSON.stringify\` mentally — the value is a string, not a nested object). Same shape as the input workflow with your changes applied. Keep node ids stable when modifying existing nodes; you may add new nodes with new ids and add edges to wire them in. The system parses this string, validates it against Janusly's strict schema, and sanitises it before returning to the operator — so structural mistakes are caught and the suggestion is dropped rather than corrupting the operator's workflow.
  - \`rationale\`: a one-paragraph operator-facing explanation written for an operator (not a developer). Name the field(s) you changed and the value(s) you chose so the operator can verify at a glance.
  - \`approachLabel\`: the dominant intent of the suggestion. Closed enum: \`add_retry\` / \`raise_timeout\` / \`swap_secret_ref\` / \`add_approval\` / \`add_observability\` / \`simplify\` / \`other\`. Match the field family you're changing.
  - \`confidence\`: a 0-100 integer self-rating. The system labels it as a self-rating in the UI; pick honestly.

Pick the MOST-IMPACTFUL angles:
- When the workflow has multiple plausible improvements, emit distinct alternatives with the highest reliability or safety payoff (typically retry + secret-ref + approval gate, in that order).
- When the workflow is already production-ready (you can't justify any change with confidence ≥ 30), return ONE suggestion with \`patchedWorkflowJson\` set to the input workflow verbatim, \`rationale\` explaining "Already production-ready", \`approachLabel: "other"\`, \`confidence: 0\`.

Improvement axes to consider (ordered by typical impact):
- \`add_retry\` — every \`http\` / \`tool\` / \`ai\` / \`agent\` node that calls an external service should have \`retry: { maxAttempts: 2-5 }\` for transient failures (5xx, ECONNRESET, ETIMEDOUT). \`maxAttempts\` must be at least 2 because 1 means no retry.
- \`raise_timeout\` — \`timeoutMs\` defaults to 30000 ms; raise modestly (60000-120000) when the upstream is known to be slow rather than removing the bound.
- \`swap_secret_ref\` — any literal-looking token, password, or API key in a node config should become \`{{secret.NAME}}\` / \`{{credential.NAME}}\` / \`{{env.NAME}}\` template references. Examples: an Authorization header literally set to "Bearer abc123" → "Bearer {{secret.AUTH_TOKEN}}".
- \`add_approval\` — for write-side workflows (anything that mutates external state: \`http\` POST/PUT/PATCH/DELETE, \`tool\` calls flagged write-side, \`ai\` calls that drive downstream writes), insert an \`approval\` node upstream as a human-in-the-loop guard.
- \`add_observability\` — when the workflow lacks declared outputs or has no \`agent\` reflection, suggest a small \`agent\` node that summarises the run for downstream consumers, OR add a richer \`condition\` expression that asserts an upstream output is non-empty.
- \`simplify\` — when a chain has multiple \`transform\` nodes back-to-back doing trivial mappings, merge them; when an unreachable edge exists, remove it. Don't aggressively re-architect — small wins only.

Rules per suggestion:
- Keep ALL node ids stable when you modify existing nodes. New nodes you add must have new unique ids; reference them in edges by id.
- Edges must connect existing node ids. Don't leave dangling edges.
- DO NOT include any literal secret values verbatim. Always use template references for tokens / passwords / keys.
- DO NOT remove a node the operator has clearly built up around (multi-edge inbound or outbound). When in doubt, keep the node and tweak its config.
- Suggestions should be DISTINCT. If you can only justify one approach, return one — don't repeat the same fix with different wording.
- DO NOT invent new node types. The valid set is the input's discriminated union — every node you emit must have a \`type\` field that matches one of the existing types in the input or one of: \`http\`, \`tool\`, \`agent\`, \`ai\`, \`transform\`, \`condition\`, \`router\`, \`approval\`, \`multi_agent\`, \`loop\`, \`noop\`.
- When \`focus\` is provided, prioritise that axis but feel free to add a second suggestion on a different axis if the focus alone wouldn't be the highest-impact change.`;

/**
 * Propose 1-3 improvements to a workflow snapshot. Never throws —
 * every failure path returns a `mode: "fallback"` response with the
 * original workflow and a rationale.
 */
export async function suggestWorkflowImprovement(
  input: SuggestWorkflowImprovementInput,
): Promise<SuggestImprovementResult> {
  const { llm, envelopeSchema, workflow, focus, model, context } = input;

  if (!llm) {
    return {
      mode: "fallback",
      suggestions: [fallbackItem(workflow, FALLBACK_RATIONALE_NO_LLM)],
    };
  }

  const trimmedFocus = typeof focus === "string" ? focus.slice(0, SUGGEST_FOCUS_MAX).trim() : "";
  const promptBody = JSON.stringify({
    workflow: scrubPromptSecretShapes(workflow),
    ...(trimmedFocus ? { focus: trimmedFocus } : {}),
  });

  try {
    const result = await llm.generateObject<SuggestEnvelopeSchemaResult>({
      schema: envelopeSchema,
      schemaName: "JanuslyWorkflowImprovement",
      schemaDescription: "One to three distinct high-impact improvements to a workflow snapshot.",
      system: SYSTEM_PROMPT,
      prompt: promptBody,
      context,
      modelHint: model,
    });
    return {
      mode: "ai",
      suggestions: result.object.suggestions,
      model: result.model,
      provider: result.provider,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      mode: "fallback",
      suggestions: [fallbackItem(workflow, `${FALLBACK_RATIONALE_NO_LLM} (Reason: ${message})`)],
      aiError: message,
    };
  }
}

/**
 * Recursively walk a value and scrub secret-shaped tokens at every
 * string leaf via the shared `scrubSecretShapes` (closed regex set in
 * `@janusly/shared/src/error-signature`). Defense-in-depth: the
 * persistence chokepoint already key-redacts known sensitive keys at
 * write time, but free-form string values that survive verbatim are
 * scrubbed here before the prompt body crosses the LLM boundary.
 */
function scrubPromptSecretShapes(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return scrubSecretShapes(value);
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

/**
 * Structured-output Zod schemas for the AI surfaces in `apps/api/src/index.ts`.
 *
 * Two surfaces, two strategies:
 *
 *   - **`/ai/generate-workflow`** — full-workflow generation. Uses
 *     `AiGenerationWorkflowSchema`, an 11-branch slim discriminated
 *     union. Each `http` / `tool` / `agent` config declares only the
 *     fields the operator MUST populate. Compiles to JSON Schema
 *     `oneOf` and works against Anthropic. OpenAI strict mode rejects
 *     `oneOf`; tracked as a follow-up — empirically, relaxing to an
 *     open shape regresses Anthropic (the model skips required fields
 *     when the schema doesn't force them), so the real fix is heavier
 *     than a one-line schema swap.
 *
 *   - **`/ai/patch-workflow`** — failure-recovery config patch. Uses
 *     ONE non-union envelope per call, picked by failing-node type via
 *     `patchEnvelopeForNodeType`. The LLM emits only the patched config
 *     (single concrete shape, no discriminator), and the route composes
 *     the suggested workflow server-side by merging into the original.
 *     Compiles WITHOUT `oneOf` — works on both providers.
 *
 * Why two strategies: a single union schema compiled at the
 * structured-output boundary is incompatible with both providers under
 * realistic field counts. Anthropic caps compiled-grammar size; OpenAI
 * strict mode bans `oneOf` outright. The generation route is constrained
 * to a slim union (one model has to emit any of the 11 types, can't
 * pre-dispatch). The patch route knows the failing-node type at request
 * time, so it can dispatch to a single concrete schema per call.
 *
 * Used by:
 *   - `apps/api/src/index.ts` — `/ai/generate-workflow` and
 *     `/ai/patch-workflow` route handlers.
 *   - `apps/api/src/ai-patch-schema.test.ts` — pins per-envelope parse
 *     behavior and the dispatcher.
 *
 * Schema constraints to keep in mind:
 *   - Anthropic structured output rejects empty `{}` schemas
 *     (`z.unknown()`, `z.any()`) with "Empty schema that accepts any
 *     JSON value is not supported." Every typed field has a concrete
 *     type. Generic config patches stay open at the Zod boundary; provider
 *     strict-mode support for those node types needs concrete per-type fields.
 *   - OpenAI strict mode rejects root-level union/composition shapes from
 *     `discriminatedUnion` and does not support `not`. Leaf `anyOf` is fine
 *     for nullable fields when each branch is otherwise valid.
 *
 * Output is re-validated by the engine's strict `WorkflowSchema` and
 * passed through `sanitizeAiWorkflow` in `apps/api/src/index.ts` before
 * reaching the operator. Engine `NodeSchema.config` is `Record<string,
 * unknown>`, so retry and bounds fields pass through verbatim.
 *
 * Adding a new node type means adding a branch to `AiNodeSchema` (for
 * the generation route) AND, if the type has rich resilience fields the
 * AI should be allowed to set, adding a per-type envelope here plus a
 * branch in `patchEnvelopeForNodeType`. Otherwise the generic envelope
 * picks it up automatically.
 */

import { EdgeSchema } from "@janusly/shared";
import { z } from "zod";

const AiCandidateSchema = z.object({
  nodeId: z.string().min(1),
});

const AiHttpNode = z.object({
  id: z.string().min(1),
  type: z.literal("http"),
  config: z.object({
    url: z.string().min(1),
    method: z.string().optional(),
  }),
});

const AiNoopNode = z.object({
  id: z.string().min(1),
  type: z.literal("noop"),
  config: z.object({}),
});

const AiTransformNode = z.object({
  id: z.string().min(1),
  type: z.literal("transform"),
  config: z.object({
    mapping: z.record(z.string(), z.string()),
  }),
});

const AiConditionNode = z.object({
  id: z.string().min(1),
  type: z.literal("condition"),
  config: z.object({
    expression: z.string().min(1),
  }),
});

const AiAiNode = z.object({
  id: z.string().min(1),
  type: z.literal("ai"),
  config: z.object({
    prompt: z.string().min(1),
  }),
});

const AiToolNode = z.object({
  id: z.string().min(1),
  type: z.literal("tool"),
  config: z.object({
    tool: z.string().min(1),
  }),
});

const AiAgentNode = z.object({
  id: z.string().min(1),
  type: z.literal("agent"),
  config: z.object({
    goal: z.string().min(1),
  }),
});

const AiRouterNode = z.object({
  id: z.string().min(1),
  type: z.literal("router"),
  config: z.object({
    candidates: z.array(AiCandidateSchema).min(1),
    strategy: z.enum(["cheapest", "fastest", "balanced", "auto"]).optional(),
  }),
});

const AiApprovalNode = z.object({
  id: z.string().min(1),
  type: z.literal("approval"),
  config: z.object({
    message: z.string().optional(),
  }),
});

const AiMultiAgentNode = z.object({
  id: z.string().min(1),
  type: z.literal("multi_agent"),
  config: z.object({
    goal: z.string().min(1),
    agents: z.array(z.object({
      name: z.string().min(1),
      role: z.string().min(1),
      goal: z.string().min(1),
    })).min(1),
  }),
});

const AiLoopNode = z.object({
  id: z.string().min(1),
  type: z.literal("loop"),
  config: z.object({
    items: z.string().min(1),
  }),
});

// AI generation emits 11 of the engine's 16 node types. Anthropic's
// structured-output grammar compiler caps schema size — empirically the
// limit is identical across `claude-haiku-4-5`, `claude-sonnet-4-5`, and
// `claude-opus-4-7` (all three accept up to 11 branches with the full
// envelope below; 12+ rejects with "The compiled grammar is too large").
// The remaining 5 (`wait_until`, `webhook`, `agent_reflection`,
// `router_llm`, `subworkflow`) stay operator-only — AI emits a `noop`
// placeholder named after the requested step and the operator promotes it
// in the Inspector. The engine's strict `WorkflowSchema` (used by /save,
// /start, /validate) still accepts all 16, so once a workflow leaves AI
// generation it has full expressiveness.
//
// CROSS-PROVIDER NOTE: this `discriminatedUnion` compiles to JSON Schema
// `oneOf`, which OpenAI strict mode rejects (`'oneOf' is not permitted`).
// Today Anthropic works (the only registered provider that accepts
// `oneOf` for structured output). OpenAI tenants on the generation
// route degrade to `mode: "fallback"`. Attempted relaxation to an open
// node shape regressed Anthropic (the model started skipping required
// fields when the schema didn't enforce them); reverted in favour of
// keeping Anthropic functional. A real cross-provider fix needs a
// heavier design — candidate paths include intent-dispatch (operator
// picks a flow style first, each style has a single non-union schema),
// two-pass generation (loose draft + per-type fill-in), or wrapping
// the AI SDK's strict-mode toggle so OpenAI accepts the union without
// enforcing.
const AiNodeSchema = z.discriminatedUnion("type", [
  AiNoopNode,
  AiHttpNode,
  AiTransformNode,
  AiConditionNode,
  AiAiNode,
  AiToolNode,
  AiAgentNode,
  AiRouterNode,
  AiApprovalNode,
  AiMultiAgentNode,
  AiLoopNode,
]);

/**
 * Workflow envelope for `/ai/generate-workflow`. Slim discriminated
 * union, 11 branches. Works on Anthropic; OpenAI strict mode rejects
 * the compiled `oneOf`. See `AiNodeSchema` above for the cross-provider
 * note.
 */
export const AiGenerationWorkflowSchema = z.object({
  dslVersion: z.literal("1.0").optional(),
  id: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  nodes: z.array(AiNodeSchema),
  edges: z.array(EdgeSchema),
});

/**
 * Patch-route schemas — `/ai/patch-workflow`. Each LLM call uses ONE
 * concrete envelope picked by the failing-node's type. The envelope wraps
 * an array of 1-3 suggestions, each with the per-type config patch plus
 * `approachLabel` + `confidence` metadata so the recovery dialog can show
 * tabs and let the operator pick between alternative fixes. The LLM emits
 * only the patched config for the failing node, NOT a full workflow.
 * The route fan-out-merges each suggestion's `patchedConfig` onto the
 * original snapshot, validates each, returns the surviving ones sorted
 * by confidence desc. Legacy `suggestedWorkflow`/`rationale` fields on
 * the response mirror `suggestions[0]` so older callers keep working.
 *
 * Why per-type envelopes instead of a single full-workflow schema:
 *
 *   - **Anthropic** caps compiled grammar size. A multi-branch
 *     `discriminatedUnion` with resilience optionals on http/tool/agent
 *     trips "The compiled grammar is too large".
 *   - **OpenAI strict mode** rejects root-level composition generated by
 *     `discriminatedUnion` (for example `oneOf`) and does not support
 *     `not`. Leaf `anyOf` is allowed for nullable fields when each branch
 *     is otherwise valid.
 *
 * A single non-union envelope per call sidesteps both: no `oneOf`
 * keyword in the compiled JSON Schema, and the per-type schema has only
 * 3-5 leaf fields so Anthropic's cap is comfortable. The 1-3 array form
 * adds one repeated `items: <single shape>` constraint, not three branches —
 * the compiled grammar stays compact.
 *
 * The four envelopes:
 *
 *   - `AiPatchHttpConfigEnvelope` — `url` / `method` / `headers` /
 *     `retry` / `timeoutMs` / `maxResponseBytes` / `maxRedirects` (all
 *     required nullable fields; the LLM sends `null` for fields it
 *     doesn't want to change). Covers URL fixes, method swaps, header
 *     swaps (including literal-token → `{{secret.NAME}}` substitutions),
 *     retry adds, timeout raises, body-cap raises. The `headers` field
 *     uses an `Array<{ name, value }>` patch form so the merge layer
 *     can fold individual header changes against the existing config
 *     without replacing the whole object — provider-safe shape that
 *     avoids `propertyNames` (OpenAI strict-mode reject).
 *   - `AiPatchToolConfigEnvelope` — `tool` / `input` / `retry` /
 *     `timeoutMs`. The `input` field uses the same `Array<{ name,
 *     value }>` patch form for the tool's flat string-keyed input map.
 *   - `AiPatchAgentConfigEnvelope` — `goal` / `retry` / `timeoutMs`.
 *   - `AiPatchGenericConfigEnvelope` — `patchedConfig: Record<string,
 *     unknown>` for the other 8 node types (transform/condition/ai/
 *     router/approval/multi_agent/loop/noop). This keeps local Zod parsing
 *     flexible, but provider strict-mode compatibility for those node types
 *     should move to concrete envelopes.
 *
 * `patchEnvelopeForNodeType(nodeType)` is the dispatch helper. The route
 * passes its result to `suggestWorkflowPatch` as the `envelopeSchema`.
 *
 * Per-suggestion metadata:
 *   - `approachLabel` — closed enum (`add_retry` / `raise_timeout` /
 *     `swap_secret_ref` / `add_approval` / `fix_url` / `other`). The
 *     dialog renders a chip per tab.
 *   - `confidence` — integer 0-100, raw LLM self-rating. Calibration
 *     against past acceptance rates lands later.
 *
 * Retry shape: `{ maxAttempts: number }` only, with `min(2)` because
 * runtime `maxAttempts: 1` means "do not retry" and the operator already
 * had at least one attempt. The engine accepts a partial `RetryPolicy`
 * and applies its own defaults for delay/backoff/jitter.
 */
// OpenAI strict-mode constraint: every property in an object schema MUST
// appear in `required`. Optional fields aren't allowed; instead each leaf
// is `.nullable()` so the LLM ALWAYS emits the field — sending `null`
// when it doesn't want to change. The route's merge step filters null
// values before applying the patch so they don't overwrite existing
// config. Anthropic accepts the same nullable-field shape, so this
// pattern unblocks both providers without per-provider code paths.
const AiPatchRetryConfig = z.object({
  maxAttempts: z.number().int().min(2).max(10),
});

/**
 * Bounded array-of-pairs patch form for fields that are normally a flat
 * record (`headers` on http nodes, `input` on tool nodes). The LLM emits
 * only the keys it wants to change. The merge layer in
 * `apps/api/src/patch-workflow-merge.ts` folds these against the
 * existing record before shallow-merging the rest of the patched config:
 * non-null `value` sets/replaces; `null` removes the key from the merged
 * record; missing keys in the array preserve whatever's already in the
 * existing config.
 *
 * Shape choice driven by provider strict modes: a `Record<string, ...>`
 * compiles to `propertyNames` which OpenAI strict mode rejects outright.
 * `Array<{ name, value }>` is one repeated `items` shape — Anthropic's
 * compiled grammar treats it as a single rule rather than N branches.
 */
const AiPatchHttpHeader = z.object({
  name: z.string().min(1),
  value: z.string().nullable(),
});

const AiPatchToolInputItem = z.object({
  name: z.string().min(1),
  value: z.string().nullable(),
});

/** Hard bound on bounded-array fields. Keeps the compiled grammar small and the merge predictable. */
const PATCH_HEADERS_MAX = 20;
const PATCH_TOOL_INPUT_MAX = 30;

const AiPatchHttpConfig = z.object({
  url: z.string().min(1).nullable(),
  method: z.string().nullable(),
  headers: z.array(AiPatchHttpHeader).max(PATCH_HEADERS_MAX).nullable(),
  retry: AiPatchRetryConfig.nullable(),
  timeoutMs: z.number().int().min(1).nullable(),
  maxResponseBytes: z.number().int().min(1).nullable(),
  maxRedirects: z.number().int().min(0).nullable(),
});

const AiPatchToolConfig = z.object({
  tool: z.string().min(1).nullable(),
  input: z.array(AiPatchToolInputItem).max(PATCH_TOOL_INPUT_MAX).nullable(),
  retry: AiPatchRetryConfig.nullable(),
  timeoutMs: z.number().int().min(1).nullable(),
});

const AiPatchAgentConfig = z.object({
  goal: z.string().min(1).nullable(),
  retry: AiPatchRetryConfig.nullable(),
  timeoutMs: z.number().int().min(1).nullable(),
});

const AiPatchGenericConfig = z.record(z.string(), z.unknown());

/**
 * Closed set of approach labels the model picks for each suggestion.
 * Used for the tab chip in the recovery dialog and for downstream
 * calibration once the feedback table lands.
 */
export const AiPatchApproachLabel = z.enum([
  "add_retry",
  "raise_timeout",
  "swap_secret_ref",
  "add_approval",
  "fix_url",
  "other",
]);
export type AiPatchApproachLabelValue = z.infer<typeof AiPatchApproachLabel>;

/** Hard upper bound on suggestions per call. Mirrors the Zod `.max(3)`. */
export const PATCH_MAX_SUGGESTIONS = 3;

function suggestionItemSchema<T extends z.ZodTypeAny>(configSchema: T) {
  return z.object({
    patchedConfig: configSchema,
    rationale: z.string().min(1),
    approachLabel: AiPatchApproachLabel,
    // Self-rated confidence 0-100. Pre-calibration MVP: the value is the
    // LLM's own number; the dialog labels it as a self-rating so operators
    // don't over-trust raw scores. Future calibration pass will rebase
    // these against past acceptance rates per `approachLabel`.
    confidence: z.number().int().min(0).max(100),
  });
}

function suggestionsArraySchema<T extends z.ZodTypeAny>(configSchema: T) {
  // The `items: <single shape>` constraint is the same for every position
  // in the array — Anthropic's compiled grammar treats this as one shape,
  // not N branches, so the `.max(3)` doesn't blow the size cap.
  return z.array(suggestionItemSchema(configSchema)).min(1).max(PATCH_MAX_SUGGESTIONS);
}

/** Envelope for http-typed failing nodes. Wraps 1-3 typed http suggestions. */
export const AiPatchHttpConfigEnvelope = z.object({
  suggestions: suggestionsArraySchema(AiPatchHttpConfig),
});

/** Envelope for tool-typed failing nodes. */
export const AiPatchToolConfigEnvelope = z.object({
  suggestions: suggestionsArraySchema(AiPatchToolConfig),
});

/** Envelope for agent-typed failing nodes. */
export const AiPatchAgentConfigEnvelope = z.object({
  suggestions: suggestionsArraySchema(AiPatchAgentConfig),
});

/**
 * Envelope for every other node type. The patched config is an open
 * record — the system prompt narrates valid fields per type, and the
 * route's post-validation chain catches structurally-invalid output.
 */
export const AiPatchGenericConfigEnvelope = z.object({
  suggestions: suggestionsArraySchema(AiPatchGenericConfig),
});

/** Discriminator returned alongside the schema so callers can branch on the parsed shape. */
export type PatchEnvelopeKind = "http" | "tool" | "agent" | "generic";

export type PatchEnvelopeChoice = {
  schema:
    | typeof AiPatchHttpConfigEnvelope
    | typeof AiPatchToolConfigEnvelope
    | typeof AiPatchAgentConfigEnvelope
    | typeof AiPatchGenericConfigEnvelope;
  kind: PatchEnvelopeKind;
};

/**
 * Pick the patch envelope for a failing-node type. Falls back to the
 * generic envelope for any type that doesn't have a richer schema —
 * keeps the patch path open for transform/condition/router/etc. without
 * inventing a per-type schema for every one of them.
 */
export function patchEnvelopeForNodeType(nodeType: string): PatchEnvelopeChoice {
  switch (nodeType) {
    case "http":
      return { schema: AiPatchHttpConfigEnvelope, kind: "http" };
    case "tool":
      return { schema: AiPatchToolConfigEnvelope, kind: "tool" };
    case "agent":
      return { schema: AiPatchAgentConfigEnvelope, kind: "agent" };
    default:
      return { schema: AiPatchGenericConfigEnvelope, kind: "generic" };
  }
}

/** Single review-finding for `/ai/review-workflow` structured output. */
const ReviewFindingSchema = z.object({
  code: z.string().min(1),
  severity: z.enum(["info", "warn", "fail"]),
  message: z.string().min(1),
  nodeId: z.string().optional(),
  edgeId: z.string().optional(),
  rationale: z.string().min(1),
  suggestion: z.string().min(1),
});

/**
 * Envelope for `/ai/review-workflow` structured output. Each finding is
 * a concrete-typed object — no `z.unknown()` (Anthropic's
 * structured-output surface rejects empty `{}` schemas), no recursion
 * (Anthropic + AI SDK reject self-`$ref`), and a hard `max(50)` cap on
 * the issue array so a hallucinating model can't dump a wall of text.
 * The shape matches `ReviewFindings` from
 * `@janusly/engine/src/workflow-review-fallback`, so the AI-mode and
 * fallback responses are wire-compatible.
 */
export const ReviewFindingsSchema = z.object({
  status: z.enum(["pass", "warn", "fail"]),
  issues: z.array(ReviewFindingSchema).max(50),
});

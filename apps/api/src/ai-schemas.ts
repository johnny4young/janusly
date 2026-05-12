/**
 * Structured-output Zod schemas for the AI surfaces in `apps/api/src/routes/ai-routes.ts`.
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
 *   - `apps/api/src/routes/ai-routes.ts` — `/ai/generate-workflow` and
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
 * passed through `sanitizeAiWorkflow` in `apps/api/src/ai-runtime.ts` before
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

const AiHumanFormFieldSchema = z.object({
  type: z.enum(["string", "number", "boolean"]),
  description: z.string().optional(),
  enum: z.array(z.string()).optional(),
});

const AiHumanFormNode = z.object({
  id: z.string().min(1),
  type: z.literal("human_form"),
  config: z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    schema: z.object({
      type: z.literal("object"),
      properties: z.record(z.string(), AiHumanFormFieldSchema),
      required: z.array(z.string()).optional(),
    }),
  }),
});

const AiLoopNode = z.object({
  id: z.string().min(1),
  type: z.literal("loop"),
  config: z.object({
    items: z.string().min(1),
  }),
});

// AI generation emits 11 of the engine's 20 node types. Anthropic's
// structured-output grammar compiler caps schema size — empirically the
// limit is identical across `claude-haiku-4-5`, `claude-sonnet-4-5`, and
// `claude-opus-4-7` (all three accept up to 11 branches with the full
// envelope below; 12+ rejects with "The compiled grammar is too large").
// The remaining 9 (`multi_agent`, `wait_until`, `webhook`,
// `agent_reflection`, `router_llm`, `subworkflow`, `parallel_fork`, `join`,
// `schedule`) stay operator-only — AI emits a `noop` placeholder named after
// the requested step (e.g. `crew_review`, `fork_lead_enrichment`,
// `join_branches`, `wait_24h`) and the operator promotes it in the Inspector
// via the type `<select>`. The engine's
// strict `WorkflowSchema` (used by /save, /start, /validate) still accepts
// all 20, so once a workflow leaves AI generation it has full
// expressiveness.
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
  AiHumanFormNode,
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
 *     unknown>` for fallback node types such as multi_agent, human_form,
 *     and noop. This keeps local Zod parsing
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

/**
 * Concrete `patchedConfig` shapes for the non-resilience node types
 * (transform / condition / ai / router / approval / loop). Each is a
 * single non-union object with nullable-required leaf fields — same
 * provider-strict pattern as the http / tool / agent envelopes. Two
 * types intentionally fall through to the generic envelope below:
 *
 *   - `multi_agent` — the `agents` array carries structurally-complex
 *     items (`name` / `role` / `goal` / optional `persona`). Encoding
 *     it provider-strict would bloat Anthropic's compiled grammar
 *     without product value: operators rarely re-shape the crew
 *     mid-recovery; they iterate on the workflow-level `goal`.
 *   - `noop` — has no actionable runtime config; an empty patch always
 *     trips the no-op guard in `patch-workflow-merge.ts`. The
 *     fall-through to the generic envelope produces the same
 *     "always falls back" behaviour without a dedicated schema.
 */
const AiPatchTransformConfig = z.object({
  // Mapping uses the same `Array<{ name, value }>` patch form as
  // `headers` / `tool input` so the LLM emits only the keys it wants
  // changed; the merge layer folds against the existing flat record.
  // Reuses `AiPatchHttpHeader` because the shape is identical today
  // (`{ name: string.min(1), value: string.nullable() }`). If HTTP
  // headers ever grow extra constraints (e.g. a lowercase-only rule),
  // factor a shared `AiPatchKeyValueItem` instead so transform doesn't
  // silently inherit them.
  mapping: z.array(AiPatchHttpHeader).max(50).nullable(),
});

const AiPatchConditionConfig = z.object({
  // The engine's `validateExpression` runs server-side after the merge
  // (in `sanitizeAiWorkflow`). The envelope only enforces non-empty
  // string; grammar-invalid expressions are dropped per-suggestion at
  // the post-validation chain.
  expression: z.string().min(1).nullable(),
});

const AiPatchAiConfig = z.object({
  prompt: z.string().min(1).nullable(),
  model: z.string().min(1).nullable(),
  retry: AiPatchRetryConfig.nullable(),
});

const AiPatchRouterCandidate = z.object({
  nodeId: z.string().min(1),
});

const AiPatchRouterConfig = z.object({
  // Replace the full candidates list verbatim (no fold). Each entry
  // must reference an existing node by id; `validateWorkflow` runs
  // server-side after the merge to enforce that.
  candidates: z.array(AiPatchRouterCandidate).max(10).nullable(),
  strategy: z.enum(["cheapest", "fastest", "balanced", "auto"]).nullable(),
});

const AiPatchApprovalConfig = z.object({
  message: z.string().min(1).nullable(),
});

const AiPatchLoopConfig = z.object({
  // Items takes a comma-separated template string OR a string array
  // at the engine boundary; the patch envelope only exposes the
  // string form (most common operator fix). If the existing config
  // uses the array form the merge replaces with a string — the
  // sanitize step keeps the workflow valid because both shapes pass
  // the engine's loop-items validation.
  items: z.string().min(1).nullable(),
  // Same reuse note as transform.mapping above — `AiPatchToolInputItem`
  // is structurally identical to `AiPatchHttpHeader` today; if either
  // source diverges, factor a shared `AiPatchKeyValueItem`.
  mapping: z.array(AiPatchToolInputItem).max(30).nullable(),
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

/** Envelope for transform-typed failing nodes — `mapping` array-of-pairs. */
export const AiPatchTransformConfigEnvelope = z.object({
  suggestions: suggestionsArraySchema(AiPatchTransformConfig),
});

/** Envelope for condition-typed failing nodes — single `expression` field. */
export const AiPatchConditionConfigEnvelope = z.object({
  suggestions: suggestionsArraySchema(AiPatchConditionConfig),
});

/** Envelope for ai-typed failing nodes — prompt swap, model swap, retry add. */
export const AiPatchAiConfigEnvelope = z.object({
  suggestions: suggestionsArraySchema(AiPatchAiConfig),
});

/** Envelope for router-typed failing nodes — replace candidates list, swap strategy. */
export const AiPatchRouterConfigEnvelope = z.object({
  suggestions: suggestionsArraySchema(AiPatchRouterConfig),
});

/** Envelope for approval-typed failing nodes — message text fixes. */
export const AiPatchApprovalConfigEnvelope = z.object({
  suggestions: suggestionsArraySchema(AiPatchApprovalConfig),
});

/** Envelope for loop-typed failing nodes — items expression + mapping array-of-pairs. */
export const AiPatchLoopConfigEnvelope = z.object({
  suggestions: suggestionsArraySchema(AiPatchLoopConfig),
});

/**
 * Envelope for every other node type (multi_agent, human_form, noop, and any
 * unrecognised future types). The patched config is an open record —
 * the system prompt narrates valid fields per type, and the route's
 * post-validation chain catches structurally-invalid output.
 */
export const AiPatchGenericConfigEnvelope = z.object({
  suggestions: suggestionsArraySchema(AiPatchGenericConfig),
});

/** Discriminator returned alongside the schema so callers can branch on the parsed shape. */
export type PatchEnvelopeKind =
  | "http"
  | "tool"
  | "agent"
  | "transform"
  | "condition"
  | "ai"
  | "router"
  | "approval"
  | "loop"
  | "generic";

export type PatchEnvelopeChoice = {
  schema:
    | typeof AiPatchHttpConfigEnvelope
    | typeof AiPatchToolConfigEnvelope
    | typeof AiPatchAgentConfigEnvelope
    | typeof AiPatchTransformConfigEnvelope
    | typeof AiPatchConditionConfigEnvelope
    | typeof AiPatchAiConfigEnvelope
    | typeof AiPatchRouterConfigEnvelope
    | typeof AiPatchApprovalConfigEnvelope
    | typeof AiPatchLoopConfigEnvelope
    | typeof AiPatchGenericConfigEnvelope;
  kind: PatchEnvelopeKind;
};

/**
 * Pick the patch envelope for a failing-node type. Node types with compact,
 * stable config patches route to concrete envelopes; structurally broad
 * types (`multi_agent`, `human_form`, `noop`) plus any unrecognised future
 * types fall through to the open generic envelope.
 */
export function patchEnvelopeForNodeType(nodeType: string): PatchEnvelopeChoice {
  switch (nodeType) {
    case "http":
      return { schema: AiPatchHttpConfigEnvelope, kind: "http" };
    case "tool":
      return { schema: AiPatchToolConfigEnvelope, kind: "tool" };
    case "agent":
      return { schema: AiPatchAgentConfigEnvelope, kind: "agent" };
    case "transform":
      return { schema: AiPatchTransformConfigEnvelope, kind: "transform" };
    case "condition":
      return { schema: AiPatchConditionConfigEnvelope, kind: "condition" };
    case "ai":
      return { schema: AiPatchAiConfigEnvelope, kind: "ai" };
    case "router":
    case "router_llm":
      return { schema: AiPatchRouterConfigEnvelope, kind: "router" };
    case "approval":
      return { schema: AiPatchApprovalConfigEnvelope, kind: "approval" };
    case "loop":
      return { schema: AiPatchLoopConfigEnvelope, kind: "loop" };
    default:
      return { schema: AiPatchGenericConfigEnvelope, kind: "generic" };
  }
}

/**
 * Suggest-improvement schemas — `/ai/suggest-improvement`. The route
 * mirrors `/ai/patch-workflow`'s response shape (a `suggestions` array
 * of items with rationale + approachLabel + confidence) but operates
 * in authoring context (no failing-node id, no DLQ row).
 *
 * Shape choice — JSON-encoded workflow string vs typed inner schema:
 *
 *   Both `/ai/generate-workflow` and the failed exploratory shape
 *   here started by emitting `AiGenerationWorkflowSchema` directly as
 *   the structured output. Anthropic accepts the bare 11-branch
 *   schema (proven by the generation route running in production),
 *   but wrapping it in an outer object plus a `suggestions` array
 *   plus metadata fields (`rationale`, `approachLabel`, `confidence`)
 *   pushes the compiled grammar over the cap (`"The compiled grammar
 *   is too large…"`). The patch route sidesteps this by emitting
 *   tiny config-only patches (3-7 leaf fields) — but the suggest
 *   surface needs the full workflow because improvements span
 *   multiple nodes/edges.
 *
 *   The minimal grammar that fits: `patchedWorkflowJson: z.string()`.
 *   The LLM emits the proposed workflow as a JSON-stringified blob.
 *   The route runs `JSON.parse` then `WorkflowSchema.safeParse` +
 *   `sanitizeAiWorkflow` server-side. Validation moves from
 *   structured-output-time to server-time, but the safety guarantee
 *   is identical — every suggestion still passes the engine's strict
 *   schema before reaching the operator. Suggestions whose JSON or
 *   schema parse fails are dropped by the route, and the surface
 *   degrades to fallback when none survive.
 *
 * Cross-provider note: this string-payload shape works on both
 * Anthropic (no `oneOf`, no nested unions, fits the cap comfortably)
 * AND OpenAI strict mode (every property `required`, no
 * `propertyNames`, no composition). When OpenAI re-opens as a
 * supported runtime target this surface should work without changes.
 * Per AGENTS.md the supported posture is Anthropic-only until
 * further notice.
 */
export const AiSuggestApproachLabel = z.enum([
  "add_retry",
  "raise_timeout",
  "swap_secret_ref",
  "add_approval",
  "add_observability",
  "simplify",
  "other",
]);
export type AiSuggestApproachLabelValue = z.infer<typeof AiSuggestApproachLabel>;

/**
 * Hard upper bound on improvement suggestions per call. Mirrors the
 * patch-route posture: 1-3 distinct alternatives, using one repeated
 * `items` schema so Anthropic's compiled grammar stays compact.
 */
export const SUGGEST_MAX_SUGGESTIONS = 3;

const AiSuggestImprovementItem = z.object({
  // JSON-stringified workflow — see envelope docstring for the
  // grammar-cap rationale. The route runs `JSON.parse` then
  // `WorkflowSchema.safeParse` + `sanitizeAiWorkflow` before
  // returning to the operator; suggestions whose parse or schema
  // fails are dropped, and the surface degrades to fallback when
  // none survive.
  patchedWorkflowJson: z.string().min(1).max(20000),
  rationale: z.string().min(1).max(800),
  approachLabel: AiSuggestApproachLabel,
  // Self-rated confidence 0-100. Same posture as the patch route: the
  // dialog labels it as a self-rating so operators don't over-trust raw
  // scores. Future calibration pass will rebase against accept/reject
  // history if a feedback loop for this surface lands.
  confidence: z.number().int().min(0).max(100),
});

/**
 * Envelope for `/ai/suggest-improvement`. Wraps 1-3
 * improvement-suggestion items — JSON-encoded workflow + rationale +
 * approachLabel + confidence. The route post-processes each item:
 * `JSON.parse` → `WorkflowSchema.safeParse` → `sanitizeAiWorkflow`,
 * dropping the suggestion if any step fails and degrading to
 * fallback when none survive.
 */
export const AiSuggestImprovementEnvelope = z.object({
  suggestions: z.array(AiSuggestImprovementItem).min(1).max(SUGGEST_MAX_SUGGESTIONS),
});

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

/**
 * Structured-output Zod schemas for the AI surfaces in `apps/api/src/index.ts`.
 *
 * Two surfaces, two strategies:
 *
 *   - **`/ai/generate-workflow`** — full-workflow generation. Uses
 *     `AiGenerationWorkflowSchema`, an 11-branch slim discriminated union.
 *     Each `http` / `tool` / `agent` config declares only the fields the
 *     operator MUST populate. Optional tuning (retry, timeouts, bounds,
 *     planner, model) is dropped to stay under Anthropic's grammar cap.
 *     This compiles to JSON Schema `oneOf` and works against Anthropic.
 *     OpenAI strict mode rejects `oneOf`; tracked separately as a
 *     follow-up.
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
 * Workflow envelope for `/ai/generate-workflow`. Slim — see the file
 * header for why retry / timeout / bounds are not allowed here.
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
 * concrete envelope picked by the failing-node's type. The envelope is a
 * single non-union shape: `{ patchedConfig, rationale }`. The LLM emits
 * only the patched config for the failing node, NOT a full workflow.
 * The route composes the suggested workflow server-side by merging the
 * patched config into the original snapshot.
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
 * 3-5 leaf fields so Anthropic's cap is comfortable.
 *
 * The four envelopes:
 *
 *   - `AiPatchHttpConfigEnvelope` — `url` / `method` / `retry` /
 *     `timeoutMs` / `maxResponseBytes` / `maxRedirects` (all required
 *     nullable fields; the LLM sends `null` for fields it doesn't want
 *     to change). Covers URL fixes, method swaps, retry adds, timeout
 *     raises, body-cap raises.
 *   - `AiPatchToolConfigEnvelope` — `tool` / `retry` / `timeoutMs`.
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

const AiPatchHttpConfig = z.object({
  url: z.string().min(1).nullable(),
  method: z.string().nullable(),
  retry: AiPatchRetryConfig.nullable(),
  timeoutMs: z.number().int().min(1).nullable(),
  maxResponseBytes: z.number().int().min(1).nullable(),
  maxRedirects: z.number().int().min(0).nullable(),
});

const AiPatchToolConfig = z.object({
  tool: z.string().min(1).nullable(),
  retry: AiPatchRetryConfig.nullable(),
  timeoutMs: z.number().int().min(1).nullable(),
});

const AiPatchAgentConfig = z.object({
  goal: z.string().min(1).nullable(),
  retry: AiPatchRetryConfig.nullable(),
  timeoutMs: z.number().int().min(1).nullable(),
});

const AiPatchGenericConfig = z.record(z.string(), z.unknown());

/** Envelope for http-typed failing nodes. Single non-union shape. */
export const AiPatchHttpConfigEnvelope = z.object({
  patchedConfig: AiPatchHttpConfig,
  rationale: z.string().min(1),
});

/** Envelope for tool-typed failing nodes. */
export const AiPatchToolConfigEnvelope = z.object({
  patchedConfig: AiPatchToolConfig,
  rationale: z.string().min(1),
});

/** Envelope for agent-typed failing nodes. */
export const AiPatchAgentConfigEnvelope = z.object({
  patchedConfig: AiPatchAgentConfig,
  rationale: z.string().min(1),
});

/**
 * Envelope for every other node type. The patched config is an open
 * record — the system prompt narrates valid fields per type, and the
 * route's post-validation chain catches structurally-invalid output.
 */
export const AiPatchGenericConfigEnvelope = z.object({
  patchedConfig: AiPatchGenericConfig,
  rationale: z.string().min(1),
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

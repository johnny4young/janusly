/**
 * Structured-output Zod schemas for the AI surfaces in `apps/api/src/index.ts`.
 *
 * Two parallel workflow schemas live here:
 *
 *   - `AiGenerationWorkflowSchema` — used by `/ai/generate-workflow`. Slim
 *     11-branch discriminated union; each `http` / `tool` / `agent` config
 *     declares only the fields the operator MUST populate. Optional tuning
 *     (retry, timeouts, bounds, planner, model) is dropped to stay under
 *     Anthropic's structured-output grammar cap.
 *
 *   - `AiPatchGenerationWorkflowSchema` — used by `/ai/patch-workflow`.
 *     Parallel 11-branch union with richer `http` / `tool` / `agent`
 *     configs that allow optional `retry` / `timeoutMs` /
 *     `maxResponseBytes` / `maxRedirects` so the most common
 *     failure-recovery fixes survive the structured-output boundary.
 *
 * Why two schemas instead of one rich schema: Anthropic's grammar compiler
 * rejects an extended generation union with "The compiled grammar is too
 * large". Empirically, even a one-field `{ maxAttempts: number }`
 * referenced from `http` / `tool` / `agent` trips the cap when added to
 * the generation union — that union is already at the edge with 11
 * branches and ~7 optionals. The patch schema is its own compilation
 * unit, so it has its own grammar budget. Splitting them lets the patch
 * route express resilience fixes without bloating the generation route.
 *
 * Used by:
 *   - `apps/api/src/index.ts` — both AI route handlers reference these.
 *   - `apps/api/src/ai-patch-schema.test.ts` — pins parse behavior.
 *
 * Schema constraints to keep in mind:
 *   - Anthropic structured output rejects empty `{}` schemas (`z.unknown()`,
 *     `z.any()`) with "Empty schema that accepts any JSON value is not
 *     supported." Every field below has a concrete type.
 *   - Anthropic limits total optional parameters across the schema to 24
 *     for grammar compilation. Both schemas stay comfortably under that
 *     budget; if a future field push trips the cap on a real call, fall
 *     back to flat fields (e.g. `retryMaxAttempts` instead of
 *     `retry.maxAttempts`) before splitting more schemas.
 *
 * Output of either schema is re-validated by the engine's strict
 * `WorkflowSchema` and then passed through `sanitizeAiWorkflow` in
 * `apps/api/src/index.ts` before reaching the operator. Engine
 * `NodeSchema.config` is `Record<string, unknown>`, so retry and bounds
 * fields pass through verbatim.
 *
 * Adding a new node type means adding a branch to BOTH `AiNodeSchema` and
 * `AiPatchNodeSchema` (or only one, if the type isn't AI-generated /
 * AI-patched), AND adding it to `nodeTypeValues` in `@janusly/shared`.
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
 * Retry shape for the patch schema's `http` / `tool` / `agent` branches.
 * `maxAttempts` only, mirroring `RetryPolicy.maxAttempts` from
 * `@janusly/engine/core/types`. The engine accepts a partial
 * `RetryPolicy` and applies its own defaults at runtime, so a single
 * field is enough to express the common fix; require at least 2 attempts
 * because runtime `maxAttempts: 1` means "do not retry". Richer tuning
 * (`delayMs`, `backoff`, `jitter`) stays operator-only via the Inspector.
 */
const AiPatchRetryConfig = z.object({
  maxAttempts: z.number().int().min(2).max(10),
});

const AiPatchHttpNode = z.object({
  id: z.string().min(1),
  type: z.literal("http"),
  config: z.object({
    url: z.string().min(1),
    method: z.string().optional(),
    retry: AiPatchRetryConfig.optional(),
    timeoutMs: z.number().int().min(1).optional(),
    maxResponseBytes: z.number().int().min(1).optional(),
    maxRedirects: z.number().int().min(0).optional(),
  }),
});

const AiPatchToolNode = z.object({
  id: z.string().min(1),
  type: z.literal("tool"),
  config: z.object({
    tool: z.string().min(1),
    retry: AiPatchRetryConfig.optional(),
    timeoutMs: z.number().int().min(1).optional(),
  }),
});

const AiPatchAgentNode = z.object({
  id: z.string().min(1),
  type: z.literal("agent"),
  config: z.object({
    goal: z.string().min(1),
    retry: AiPatchRetryConfig.optional(),
    timeoutMs: z.number().int().min(1).optional(),
  }),
});

const AiPatchNodeSchema = z.discriminatedUnion("type", [
  AiNoopNode,
  AiPatchHttpNode,
  AiTransformNode,
  AiConditionNode,
  AiAiNode,
  AiPatchToolNode,
  AiPatchAgentNode,
  AiRouterNode,
  AiApprovalNode,
  AiMultiAgentNode,
  AiLoopNode,
]);

/**
 * Workflow envelope for `/ai/patch-workflow`. Richer than
 * `AiGenerationWorkflowSchema` on the resilience-knob axis (retry,
 * timeoutMs, maxResponseBytes, maxRedirects on http/tool/agent configs).
 * The 8 non-richer branches reuse the slim node schemas verbatim.
 */
export const AiPatchGenerationWorkflowSchema = z.object({
  dslVersion: z.literal("1.0").optional(),
  id: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  nodes: z.array(AiPatchNodeSchema),
  edges: z.array(EdgeSchema),
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

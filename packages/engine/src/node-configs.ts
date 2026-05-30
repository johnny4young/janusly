/**
 * Typed per-node-type config schemas.
 *
 * Today the API-boundary `WorkflowSchema` validates the workflow's shape
 * but treats each node's `config` as `z.record(z.string(), z.unknown())`
 * — an opaque map. Inside the engine, every executor destructures
 * fields without compile-time guarantees: a typo like
 * `{ uri: "..." }` (vs `url`) on an http node sails through the API
 * gate and produces an unhelpful `cannot read property X of undefined`
 * at runtime.
 *
 * The schemas in this module are the inner refinement. The dispatcher
 * in `execute-node.ts` calls `parseNodeConfig(node.type, resolvedConfig)`
 * before invoking the executor; a parse failure throws and the outer
 * envelope catches it into `{ ok: false, error: "<zod-issue-path>" }`
 * per the AI-fallback contract.
 *
 * **Defensive posture:** each schema validates the REQUIRED fields the
 * executor relies on and leaves optional fields loose (`z.unknown()` or
 * `.optional()`). Objects use `.passthrough()` so unknown keys flow
 * through — the goal is to catch typos in REQUIRED fields without
 * rejecting workflows that ship extra metadata the executor ignores.
 * Tightening individual schemas is a per-node follow-up; the
 * compounding type-safety payoff arrives when `NodeContext.config`
 * itself becomes generic on the executor signature (separate ticket).
 *
 * Used by:
 * - `packages/engine/src/execute-node.ts` — the dispatcher's parse
 *   call before executor invocation.
 * - `packages/engine/src/agent-planner.ts` — `planAgentTool` /
 *   `planAgentToolWithLLM` accept the inferred agent-config shape.
 */

import { z } from "zod";
import { nodeTypeValues, type NodeType } from "@janusly/shared/src/workflow";
import {
  EmailReceivedConfigSchema,
  FileDroppedConfigSchema,
  McpServerEventConfigSchema,
} from "@janusly/shared/src/trigger-types";

export const HttpNodeConfigSchema = z
  .object({
    url: z.string().min(1, "http.url is required"),
    method: z
      .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
      .optional(),
    headers: z.record(z.string(), z.unknown()).optional(),
    body: z.unknown().optional(),
    timeoutMs: z.number().int().positive().optional(),
    maxResponseBytes: z.number().int().positive().optional(),
    maxRedirects: z.number().int().nonnegative().optional(),
    bodyMode: z.enum(["buffer", "stream"]).optional(),
    streamPreviewBytes: z.number().int().positive().optional(),
  })
  .passthrough();

export const ConditionNodeConfigSchema = z
  .object({
    expression: z.string().min(1, "condition.expression is required"),
  })
  .passthrough();

export const ToolNodeConfigSchema = z
  .object({
    tool: z.string().min(1, "tool.tool is required"),
    input: z.unknown().optional(),
  })
  .passthrough();

export const AgentNodeConfigSchema = z
  .object({
    goal: z.string().optional(),
    tool: z.string().optional(),
    input: z.unknown().optional(),
    value: z.string().optional(),
    text: z.string().optional(),
    path: z.string().optional(),
    url: z.string().optional(),
    method: z.string().optional(),
    headers: z.unknown().optional(),
    body: z.unknown().optional(),
    planner: z.enum(["rules", "openai"]).optional(),
    maxSteps: z.number().int().positive().max(50).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .passthrough();

export const MultiAgentNodeConfigSchema = z
  .object({
    agents: z.array(z.unknown()).optional(),
    mode: z.enum(["sequential", "parallel"]).optional(),
    aggregation: z.string().optional(),
    continueOnError: z.boolean().optional(),
    goal: z.string().optional(),
    reflection: z.boolean().optional(),
    planner: z.enum(["rules", "openai"]).optional(),
    maxSteps: z.number().int().positive().max(50).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .passthrough();

export const AgentReflectionNodeConfigSchema = z
  .object({
    input: z.unknown().optional(),
  })
  .passthrough();

export const LoopNodeConfigSchema = z
  .object({
    // Executor handles undefined items gracefully (falls back to empty
    // iteration) so the field is optional at this layer.
    items: z.unknown().optional(),
    mapping: z.unknown().optional(),
  })
  .passthrough();

export const RouterNodeConfigSchema = z
  .object({
    candidates: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const RouterLlmNodeConfigSchema = z
  .object({
    candidates: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const TransformNodeConfigSchema = z
  .object({
    mapping: z.unknown().optional(),
  })
  .passthrough();

export const AiNodeConfigSchema = z
  .object({
    prompt: z.string().optional(),
    promptRef: z
      .object({
        name: z.string().min(1),
        version: z.number().int().positive().optional(),
      })
      .passthrough()
      .optional(),
    variables: z.record(z.string(), z.unknown()).optional(),
    model: z.string().optional(),
  })
  .passthrough();

export const ApprovalNodeConfigSchema = z
  .object({
    message: z.string().optional(),
  })
  .passthrough();

export const HumanFormNodeConfigSchema = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
    // The executor parses `schema` against the engine's strict
    // `WorkflowInputSchema`, which throws on undefined / bad shape — so
    // the real gate lives downstream. Kept loose here.
    schema: z.unknown().optional(),
  })
  .passthrough();

export const SubworkflowNodeConfigSchema = z
  .object({
    workflowId: z.string().min(1, "subworkflow.workflowId is required"),
    input: z.unknown().optional(),
  })
  .passthrough();

export const WaitUntilNodeConfigSchema = z
  .object({
    duration: z.string().min(1, "wait_until.duration is required"),
  })
  .passthrough();

export const ScheduleNodeConfigSchema = z
  .object({
    cronExpression: z
      .string()
      .min(1, "schedule.cronExpression is required"),
    enabled: z.boolean().optional(),
  })
  .passthrough();

export const McpToolNodeConfigSchema = z
  .object({
    connectionAlias: z
      .string()
      .min(1, "mcp_tool.connectionAlias is required"),
    toolName: z.string().min(1, "mcp_tool.toolName is required"),
    input: z.unknown().optional(),
    timeoutMs: z.number().int().positive().max(120_000).optional(),
  })
  .passthrough();

export const ParallelForkNodeConfigSchema = z
  .object({
    branches: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const JoinNodeConfigSchema = z
  .object({
    sources: z.unknown().optional(),
  })
  .passthrough();

/**
 * Loose-shape placeholders. `webhook` is a waiting-state stub the engine
 * resumes from outside; `noop` is the AI generation placeholder; the
 * shape is operator-only and the executor consumes nothing today.
 */
export const WebhookNodeConfigSchema = z.object({}).passthrough();
export const NoopNodeConfigSchema = z.object({}).passthrough();

/**
 * Per-node-type schema registry. Declared with `satisfies` (not a plain
 * `Record<NodeType, z.ZodTypeAny>` annotation) so `(typeof NODE_CONFIG_SCHEMAS)[K]`
 * preserves the per-key concrete schema type — `NodeConfigByType["http"]`
 * therefore infers to the typed HTTP config shape rather than `any`.
 */
export const NODE_CONFIG_SCHEMAS = {
  http: HttpNodeConfigSchema,
  condition: ConditionNodeConfigSchema,
  tool: ToolNodeConfigSchema,
  agent: AgentNodeConfigSchema,
  multi_agent: MultiAgentNodeConfigSchema,
  agent_reflection: AgentReflectionNodeConfigSchema,
  loop: LoopNodeConfigSchema,
  router: RouterNodeConfigSchema,
  router_llm: RouterLlmNodeConfigSchema,
  transform: TransformNodeConfigSchema,
  ai: AiNodeConfigSchema,
  webhook: WebhookNodeConfigSchema,
  approval: ApprovalNodeConfigSchema,
  human_form: HumanFormNodeConfigSchema,
  noop: NoopNodeConfigSchema,
  subworkflow: SubworkflowNodeConfigSchema,
  wait_until: WaitUntilNodeConfigSchema,
  parallel_fork: ParallelForkNodeConfigSchema,
  join: JoinNodeConfigSchema,
  schedule: ScheduleNodeConfigSchema,
  mcp_tool: McpToolNodeConfigSchema,
  // Event-driven trigger node types — the authoring-side config schemas live
  // in `@janusly/shared/src/trigger-types` so the API ingestion seam and the
  // web Inspector share one contract.
  email_received: EmailReceivedConfigSchema,
  file_dropped: FileDroppedConfigSchema,
  mcp_server_event: McpServerEventConfigSchema,
} satisfies Record<NodeType, z.ZodTypeAny>;

/** Mapped type — `NodeConfigByType["http"]` is the inferred HTTP config shape. */
export type NodeConfigByType = {
  [K in NodeType]: z.infer<(typeof NODE_CONFIG_SCHEMAS)[K]>;
};

/** Convenience alias for a single agent-node config — consumed by
 *  `agent-planner.ts` to type its `config` parameter. */
export type AgentNodeConfig = z.infer<typeof AgentNodeConfigSchema>;

/**
 * Parse a raw config blob against the schema for the given node type.
 * Throws a Zod `ZodError` with the offending path / message on failure;
 * callers in the engine catch it via the standard executor envelope so
 * the run lands in `failed` with a helpful error.
 *
 * The closed-enum dispatch on `nodeTypeValues` means unknown node types
 * are rejected early — a placeholder defense against drift between the
 * shared workflow schema and this registry.
 */
export function parseNodeConfig<T extends NodeType>(
  type: T,
  rawConfig: unknown,
): NodeConfigByType[T] {
  if (!(nodeTypeValues as readonly string[]).includes(type)) {
    throw new Error(`parseNodeConfig: unknown node type "${type}"`);
  }
  const schema = NODE_CONFIG_SCHEMAS[type];
  return schema.parse(rawConfig) as NodeConfigByType[T];
}

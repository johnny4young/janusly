/**
 * Workflow contract — Zod 4 schemas + inferred TypeScript types for the
 * canonical Janusly workflow shape.
 *
 * This module is the single source of truth for what a workflow, node, edge,
 * and metadata block look like. Every other workspace either parses incoming
 * payloads against `WorkflowSchema` or writes outgoing payloads matching it,
 * which is how the AI Studio, the engine runtime, and the persisted DAG JSON
 * stay in lockstep.
 *
 * Used by:
 * - `apps/api/src/index.ts` — `WorkflowSchema.parse` on `/start`, `/save`,
 *   `/validate`, AI generation, etc.
 * - `packages/engine/src/workflow-validation.ts` — graph-level validation runs
 *   on top of the schema-level parse.
 * - `packages/engine/src/start-run.ts` / `resume-run.ts` — read parsed nodes.
 * - `packages/engine/src/worker.ts` — `NodeSchema.parse(job.data)` on every
 *   BullMQ job (poison-payload protection).
 *
 * Invariants:
 * - `nodeTypeValues` is the closed set of node kinds the runtime supports.
 *   Adding a new kind requires both an entry here AND a matching executor in
 *   `packages/engine/src/node-registry.ts`.
 * - `dslVersion` defaults to "1.0"; bumping the version is a breaking change
 *   that requires a migration of persisted workflow JSON in `workflow_versions`.
 * - Records use Zod 4's two-arg `z.record(z.string(), z.unknown())` form (per
 *   AGENTS.md). Don't drop back to the single-arg legacy shape.
 */

import { z } from "zod";

/**
 * Current DSL version. Persisted workflows store this; older versions need a
 * migration before they parse cleanly against `WorkflowSchema`.
 */
export const workflowDslVersion = "1.0" as const;

/**
 * Closed set of node-type discriminators. Adding a new value here is a
 * one-step compile-time check across the runtime — every consumer that
 * switches on `node.type` will fail to build until it handles the new case.
 */
export const nodeTypeValues = [
  "http",
  "condition",
  "tool",
  "agent",
  "multi_agent",
  "agent_reflection",
  "loop",
  "router",
  "router_llm",
  "transform",
  "ai",
  "webhook",
  "approval",
  "human_form",
  "noop",
  "subworkflow",
  "wait_until",
  "parallel_fork",
  "join",
  "schedule",
  "mcp_tool",
  // Event-driven trigger node types (config + inbound-payload contracts in
  // `trigger-types.ts`). NOT emitted by AI generation — operators promote a
  // `noop` placeholder in the Inspector, mirroring the `wait_*` / `schedule_*`
  // convention. The grammar cap on `/ai/generate-workflow` stays at 11.
  "email_received",
  "file_dropped",
  "mcp_server_event",
] as const;

/** Zod enum derived from `nodeTypeValues`; powers `NodeSchema`'s `type` field. */
export const NodeTypeSchema = z.enum(nodeTypeValues);

/**
 * Single node in a workflow DAG.
 *
 * `config` is intentionally `Record<string, unknown>` — each node type
 * interprets its own config shape inside its executor. The runtime never
 * looks at `config` generically.
 */
export const NodeSchema = z.object({
  id: z.string().trim().min(1, "Node id is required"),
  type: NodeTypeSchema,
  config: z.record(z.string(), z.unknown()).default({}),
});

/**
 * Directed edge between two nodes.
 *
 * `condition` is an optional Janusly expression (validated separately by
 * `packages/engine/src/expression.ts`); when present, the edge only fires when
 * the expression evaluates truthy.
 */
export const EdgeSchema = z.object({
  id: z.string().trim().min(1).optional(),
  from: z.string().trim().min(1, "Edge source is required"),
  to: z.string().trim().min(1, "Edge target is required"),
  condition: z.string().trim().min(1).optional(),
});

/**
 * Inline JSON-shaped descriptive metadata that lives on each workflow's
 * serialized form (`description`, `tags`). Distinct from the operational
 * metadata layer (owners + runbook + slackChannel etc.) that lives in
 * the `workflow_metadata` table and is keyed by `(orgId, workflowId)`.
 * `tags` defaults to `[]` so callers always see an array.
 */
export const WorkflowJsonMetadataSchema = z.object({
  description: z.string().trim().optional(),
  tags: z.array(z.string().trim().min(1)).default([]),
}).default({ tags: [] });

/**
 * Closed set of JSON-Schema-subset primitive `type` discriminators supported
 * by `WorkflowInputSchema`. Matches the small grammar
 * `packages/engine/src/inputs-validator.ts` understands — adding a new
 * primitive here means adding a matching branch there.
 */
export const workflowInputTypeValues = ["string", "number", "boolean", "object", "array"] as const;
/** Zod enum derived from `workflowInputTypeValues`. */
export const WorkflowInputTypeSchema = z.enum(workflowInputTypeValues);

/**
 * JSON-Schema-subset describing one input field on a workflow's declared
 * `inputs` shape. Recursive via `z.lazy` (object → properties → fields;
 * array → items). Powers `WorkflowSchema.inputs`.
 *
 * The grammar is intentionally limited:
 * - `type`: one of `workflowInputTypeValues`.
 * - `properties` + `required`: only meaningful for `type: "object"`.
 * - `items`: only meaningful for `type: "array"`.
 * - `enum`: closed set of literal values the field must equal one of.
 * - `description`: free-form, surfaces in the AI Studio Inspector.
 *
 * No `oneOf` / `anyOf` / patterns / number ranges yet — expand the subset
 * (here AND in the hand-rolled validator) only when a real consumer needs it.
 */
export const WorkflowInputSchema: z.ZodType<WorkflowInputSchemaShape> = z.lazy(() => z.object({
  type: WorkflowInputTypeSchema,
  description: z.string().optional(),
  properties: z.record(z.string(), WorkflowInputSchema).optional(),
  required: z.array(z.string()).optional(),
  items: WorkflowInputSchema.optional(),
  enum: z.array(z.unknown()).optional(),
}));

/**
 * The "shape" type for a `WorkflowInputSchema` value. Hand-written rather than
 * `z.infer<>` because Zod can't derive the recursive shape through `z.lazy`
 * without an explicit type seed.
 */
export type WorkflowInputSchemaShape = {
  type: typeof workflowInputTypeValues[number];
  description?: string;
  properties?: Record<string, WorkflowInputSchemaShape>;
  required?: string[];
  items?: WorkflowInputSchemaShape;
  enum?: unknown[];
};

/**
 * `outputs` is a record of output-name → template string. At terminal
 * (`succeeded`) status, the engine renders each template against the run's
 * context using `renderTemplate` (`packages/engine/src/template.ts`) and
 * persists the result to `runs.outputJson`. Shape:
 *   { result: "{{context.summarize.output.text}}", count: "{{context.fetch.output.length}}" }
 *
 * Outputs are intentionally string templates (not the same JSON-Schema
 * shape as `inputs`) because outputs are *projections* from existing
 * context, not types the workflow *declares* it produces. Reusing the
 * existing template substitution language avoids inventing a second one.
 */
export const WorkflowOutputsSchema = z.record(z.string(), z.string());

/**
 * Top-level workflow definition. Persisted as JSON in
 * `workflow_versions.dag_json` and consumed by the engine.
 */
export const WorkflowSchema = z.object({
  dslVersion: z.literal(workflowDslVersion).default(workflowDslVersion),
  id: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).optional(),
  metadata: WorkflowJsonMetadataSchema.optional(),
  inputs: WorkflowInputSchema.optional(),
  outputs: WorkflowOutputsSchema.optional(),
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
});

/** Discriminator type for the closed set of node kinds. */
export type NodeType = z.infer<typeof NodeTypeSchema>;
/** Single workflow node, fully parsed (config defaulted to `{}`). */
export type WorkflowNode = z.infer<typeof NodeSchema>;
/** Single workflow edge, fully parsed. */
export type WorkflowEdge = z.infer<typeof EdgeSchema>;
/** Parsed metadata block with defaulted `tags`. */
export type WorkflowJsonMetadata = z.infer<typeof WorkflowJsonMetadataSchema>;
/** Closed set of JSON-Schema-subset primitive types. */
export type WorkflowInputType = z.infer<typeof WorkflowInputTypeSchema>;
/** Output-projection map (output-name → template string). */
export type WorkflowOutputs = z.infer<typeof WorkflowOutputsSchema>;
/** Top-level parsed workflow. */
export type Workflow = z.infer<typeof WorkflowSchema>;

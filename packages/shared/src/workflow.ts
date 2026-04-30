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
  "noop",
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

/** Free-form descriptive metadata; `tags` defaults to `[]` so callers always see an array. */
export const WorkflowMetadataSchema = z.object({
  description: z.string().trim().optional(),
  tags: z.array(z.string().trim().min(1)).default([]),
}).default({ tags: [] });

/**
 * Top-level workflow definition. Persisted as JSON in
 * `workflow_versions.dag_json` and consumed by the engine.
 */
export const WorkflowSchema = z.object({
  dslVersion: z.literal(workflowDslVersion).default(workflowDslVersion),
  id: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).optional(),
  metadata: WorkflowMetadataSchema.optional(),
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
export type WorkflowMetadata = z.infer<typeof WorkflowMetadataSchema>;
/** Top-level parsed workflow. */
export type Workflow = z.infer<typeof WorkflowSchema>;

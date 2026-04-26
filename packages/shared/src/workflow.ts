import { z } from "zod";

export const nodeTypeValues = [
  "http",
  "condition",
  "tool",
  "agent",
  "multi_agent",
  "agent_reflection",
  "loop",
  "transform",
  "ai",
  "webhook",
  "approval",
  "noop",
] as const;

export const NodeTypeSchema = z.enum(nodeTypeValues);

export const NodeSchema = z.object({
  id: z.string().trim().min(1, "Node id is required"),
  type: NodeTypeSchema,
  config: z.record(z.string(), z.unknown()).default({}),
});

export const EdgeSchema = z.object({
  id: z.string().trim().min(1).optional(),
  from: z.string().trim().min(1, "Edge source is required"),
  to: z.string().trim().min(1, "Edge target is required"),
  condition: z.string().trim().min(1).optional(),
});

export const WorkflowSchema = z.object({
  id: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).optional(),
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
});

export type NodeType = z.infer<typeof NodeTypeSchema>;
export type WorkflowNode = z.infer<typeof NodeSchema>;
export type WorkflowEdge = z.infer<typeof EdgeSchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;

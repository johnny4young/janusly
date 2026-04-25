import { z } from "zod";

export const NodeSchema = z.object({
  id: z.string(),
  type: z.string(),
  config: z.record(z.any()),
});

export const EdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
});

export const WorkflowSchema = z.object({
  id: z.string(),
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
});

export type Workflow = z.infer<typeof WorkflowSchema>;

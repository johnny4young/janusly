/**
 * `resumeRun` — release a run that was paused at an `approval` or `webhook`
 * node back into the queue.
 *
 * Used by:
 * - `apps/api/src/index.ts` `POST /resume` — when a human approves or a
 *   webhook payload arrives.
 *
 * Invariants:
 * - Marks the paused node as succeeded and re-enqueues downstream nodes
 *   through the `BullMQQueueAdapter` (so the DLQ contract stays in the
 *   path).
 * - Multi-tenant scope: every query filters on the run's `org_id` via the
 *   shared `db` instance.
 */

import { db } from "@janusly/db";
import { runs } from "@janusly/db";
import { eq } from "drizzle-orm";
import { appendEvent, markWaitingNodeSucceeded, updateRunStatusFromNodes } from "./persistence";
import { BullMQQueueAdapter } from "./adapters/bullmq-queue-adapter";
import { PostgresExecutionStore } from "./adapters/postgres-execution-store";
import { WorkflowRuntime } from "./core/runtime";
import { WorkflowInputSchema, WorkflowSchema } from "@janusly/shared";
import { validateInputs, WorkflowInputValidationError } from "./inputs-validator";
import { verifyResumeToken } from "./secrets";

const runtime = new WorkflowRuntime(
  new PostgresExecutionStore(),
  new BullMQQueueAdapter(),
  {
    execute: async () => ({}),
  },
);

export class ResumeRunConflictError extends Error {
  constructor(message = "Node is not waiting") {
    super(message);
    this.name = "ResumeRunConflictError";
  }
}

export type ResumeRunOptions = {
  input?: unknown;
  resumeToken?: string;
};

export async function resumeRun(runId: string, nodeId: string, options: ResumeRunOptions = {}) {
  const run = await db.select().from(runs).where(eq(runs.id, runId));

  if (!run[0]) {
    throw new Error("Run not found");
  }

  const inputJson = run[0].inputJson as { workflow?: unknown } | null;
  const workflow = WorkflowSchema.parse(inputJson?.workflow);
  const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error("Node not found");

  let output: unknown = {};
  if (node.type === "human_form") {
    if (typeof options.resumeToken !== "string" || !options.resumeToken) {
      throw new Error("resumeToken is required");
    }
    verifyResumeToken(options.resumeToken, {
      orgId: run[0].orgId,
      runId,
      nodeId,
      purpose: "human_form",
    });
    const schema = WorkflowInputSchema.parse(node.config.schema);
    const validation = validateInputs(schema, options.input ?? {});
    if (!validation.valid) throw new WorkflowInputValidationError(validation.errors);
    output = options.input ?? {};
  }

  const completed = await markWaitingNodeSucceeded(runId, nodeId, output);
  if (!completed) throw new ResumeRunConflictError();
  await appendEvent(runId, nodeId, "node.resumed", node.type === "human_form" ? { output } : {});

  await runtime.enqueueReadyNodes({ runId, workflow });
  await updateRunStatusFromNodes(runId);

  return { resumed: true };
}

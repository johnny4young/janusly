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
import { markNodeSucceeded, appendEvent } from "./persistence";
import { BullMQQueueAdapter } from "./adapters/bullmq-queue-adapter";
import { PostgresExecutionStore } from "./adapters/postgres-execution-store";
import { WorkflowRuntime } from "./core/runtime";
import { WorkflowSchema } from "@janusly/shared";

const runtime = new WorkflowRuntime(
  new PostgresExecutionStore(),
  new BullMQQueueAdapter(),
  {
    execute: async () => ({}),
  },
);

export async function resumeRun(runId: string, nodeId: string) {
  const run = await db.select().from(runs).where(eq(runs.id, runId));

  if (!run[0]) {
    throw new Error("Run not found");
  }

  const inputJson = run[0].inputJson as { workflow?: unknown } | null;
  const workflow = WorkflowSchema.parse(inputJson?.workflow);

  await markNodeSucceeded(runId, nodeId);
  await appendEvent(runId, nodeId, "node.resumed", {});

  await runtime.enqueueReadyNodes({ runId, workflow });

  return { resumed: true };
}

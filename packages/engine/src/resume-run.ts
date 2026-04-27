import { db } from "@workflow-engine/db";
import { runs } from "@workflow-engine/db";
import { eq } from "drizzle-orm";
import { markNodeSucceeded, appendEvent } from "./persistence";
import { BullMQQueueAdapter } from "./adapters/bullmq-queue-adapter";
import { PostgresExecutionStore } from "./adapters/postgres-execution-store";
import { WorkflowRuntime } from "./core/runtime";
import { WorkflowSchema } from "@workflow-engine/shared";

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

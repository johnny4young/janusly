import type { Workflow } from "@workflow-engine/shared";
import { WorkflowRuntime } from "./core/runtime";
import { PostgresExecutionStore } from "./adapters/postgres-execution-store";
import { BullMQQueueAdapter } from "./adapters/bullmq-queue-adapter";
import { executeNode } from "./execute-node";

const runtime = new WorkflowRuntime(
  new PostgresExecutionStore(),
  new BullMQQueueAdapter(),
  {
    execute: async ({ runId, node }) => executeNode({ runId, node }),
  }
);

/**
 * @deprecated Use WorkflowRuntime.enqueueReadyNodes instead.
 * Kept as a compatibility facade while older callers migrate to the runtime.
 */
export async function enqueueNextNodes({ runId, workflow }: { runId: string; workflow: Workflow }) {
  return runtime.enqueueReadyNodes({ runId, workflow });
}

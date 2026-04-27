import { Worker } from "bullmq";
import { ensureDatabaseSchema } from "@janusly/db/src/schema-management";
import { connection } from "./queue";
import { WorkflowRuntime } from "./core/runtime";
import { PostgresExecutionStore } from "./adapters/postgres-execution-store";
import { BullMQQueueAdapter } from "./adapters/bullmq-queue-adapter";
import { executeNode } from "./execute-node";

await ensureDatabaseSchema();

const runtime = new WorkflowRuntime(
  new PostgresExecutionStore(),
  new BullMQQueueAdapter(),
  {
    execute: async ({ runId, node }) => {
      return executeNode({ runId, node });
    },
  }
);

export const worker = new Worker(
  "workflow-nodes",
  async (job) => {
    const { runId, node, workflow } = job.data;

    await runtime.executeQueuedNode({ runId, node, workflow });
  },
  {
    connection,
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 10),
  }
);

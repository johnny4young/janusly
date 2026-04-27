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

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] received ${signal}, draining in-flight jobs…`);
  try {
    await worker.close();
    console.log("[worker] drained, exiting");
    process.exit(0);
  } catch (error) {
    console.error("[worker] shutdown error", error);
    process.exit(1);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

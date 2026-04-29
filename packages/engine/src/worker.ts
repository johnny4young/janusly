import { Worker, UnrecoverableError } from "bullmq";
import { NodeSchema, WorkflowSchema } from "@janusly/shared";
import { assertMigrationsApplied } from "@janusly/db/src/migrations";
import { connection } from "./queue";
import { WorkflowRuntime } from "./core/runtime";
import { PostgresExecutionStore } from "./adapters/postgres-execution-store";
import { BullMQQueueAdapter } from "./adapters/bullmq-queue-adapter";
import { executeNode } from "./execute-node";

await assertMigrationsApplied();

const runtime = new WorkflowRuntime(
  new PostgresExecutionStore(),
  new BullMQQueueAdapter(),
  {
    execute: async ({ runId, node }) => {
      return executeNode({ runId, node });
    },
  }
);

function validateJobData(data: unknown): { runId: string; node: unknown; workflow: unknown } {
  if (!data || typeof data !== "object") {
    throw new UnrecoverableError("Invalid job data: not an object");
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.runId !== "string" || obj.runId.length === 0) {
    throw new UnrecoverableError("Invalid job data: missing runId");
  }
  const node = NodeSchema.safeParse(obj.node);
  if (!node.success) {
    throw new UnrecoverableError(`Invalid job data (node): ${node.error.issues.map((i) => i.message).join(", ")}`);
  }
  const workflow = WorkflowSchema.safeParse(obj.workflow);
  if (!workflow.success) {
    throw new UnrecoverableError(`Invalid job data (workflow): ${workflow.error.issues.map((i) => i.message).join(", ")}`);
  }
  return { runId: obj.runId, node: node.data, workflow: workflow.data };
}

export const worker = new Worker(
  "workflow-nodes",
  async (job) => {
    const { runId, node, workflow } = validateJobData(job.data);
    await runtime.executeQueuedNode({ runId, node: node as any, workflow: workflow as any });
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

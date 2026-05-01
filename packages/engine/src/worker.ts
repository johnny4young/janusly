/**
 * Engine worker process — pulls workflow-node jobs off the BullMQ queue and
 * runs them through the `WorkflowRuntime`.
 *
 * Lifecycle:
 *   1. `assertMigrationsApplied()` — fail-fast if Postgres isn't migrated
 *      (ENG-008 invariant; AGENTS.md explicitly forbids the deleted runtime
 *      `CREATE TABLE` bootstrap).
 *   2. Build a `WorkflowRuntime` with the Postgres execution store + BullMQ
 *      queue adapter (which composes the DLQ adapter — the DLQ contract is
 *      part of the queue layer per AGENTS.md).
 *   3. Open a BullMQ `Worker` on `connection` from `./queue`. Each job is
 *      validated with `NodeSchema.parse(job.data)` — bad payloads become
 *      `UnrecoverableError` so they go to the DLQ instead of retrying
 *      forever (ENG-002 invariant).
 *   4. SIGTERM/SIGINT call `worker.close()` so in-flight jobs drain on
 *      container restart and `running` nodes don't get orphaned.
 *
 * Invariants:
 * - Top-level await is intentional — the migration assertion is mandatory
 *   before any work happens.
 * - Don't bypass `BullMQQueueAdapter`'s DLQ composition. Failed-beyond-retry
 *   jobs must land in `dead_letters`.
 * - The signal handlers must keep calling `worker.close()` so the project's
 *   "no orphan running nodes" invariant survives restarts.
 */

import { Worker, UnrecoverableError } from "bullmq";
import { NodeSchema, WorkflowSchema } from "@janusly/shared";
import { assertMigrationsApplied } from "@janusly/db/src/migrations";
import { setUsageRecorder } from "@janusly/ai";
import { recordUsage } from "@janusly/data/src/usageRepo";
import { connection } from "./queue";
import { WorkflowRuntime } from "./core/runtime";
import { PostgresExecutionStore } from "./adapters/postgres-execution-store";
import { BullMQQueueAdapter } from "./adapters/bullmq-queue-adapter";
import { executeNode } from "./execute-node";

await assertMigrationsApplied();

// ENG-012: register the usage_events writer once at boot. Every LLM call
// from the `ai` node and `agent` planner fires it fire-and-forget.
setUsageRecorder(recordUsage);

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

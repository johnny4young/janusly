/**
 * Engine worker process — pulls workflow-node jobs off the BullMQ queue and
 * runs them through the `WorkflowRuntime`.
 *
 * Lifecycle:
 *   1. `assertMigrationsApplied()` — fail-fast if Postgres isn't migrated
 *      (AGENTS.md explicitly forbids the deleted runtime
 *      `CREATE TABLE` bootstrap).
 *   2. Build a `WorkflowRuntime` with the Postgres execution store + BullMQ
 *      queue adapter (which composes the DLQ adapter — the DLQ contract is
 *      part of the queue layer per AGENTS.md).
 *   3. Open a BullMQ `Worker` on `connection` from `./queue`. Each job is
 *      validated with `NodeSchema.parse(job.data)` — bad payloads become
 *      `UnrecoverableError` so they go to the DLQ instead of retrying
 *      forever.
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
import { recordEmailUsage, recordIntegrationUsage, recordPdfUsage, recordUsage } from "@janusly/data/src/usageRepo";
import { setEmailUsageRecorder } from "./email-usage";
import { setIntegrationUsageRecorder } from "./integration-usage";
import { setPdfUsageRecorder } from "./pdf-usage";
import { setEngineRateLimiter } from "./rate-limit";
import { setBudgetChecker } from "./budget";
import { productionBudgetChecker } from "@janusly/data/src/budgetRepo";
import { closeWorkerRateLimitRedis, enforceWorkerRateLimit } from "./rate-limit-redis";
import { connection } from "./queue";
import { WorkflowRuntime } from "./core/runtime";
import { PostgresExecutionStore } from "./adapters/postgres-execution-store";
import { BullMQQueueAdapter } from "./adapters/bullmq-queue-adapter";
import { executeNode } from "./execute-node";
import { handleWaitResume } from "./wait-until";
import { handleScheduleTrigger, replayAllScheduleEntries } from "./schedule-scheduler";

await assertMigrationsApplied();

// Re-register every enabled schedule entry with BullMQ BEFORE the
// worker starts pulling jobs. Idempotent via the deterministic
// `schedule:<orgId>:<versionId>:<nodeId>` id, so this is safe across
// multiple worker replicas and across Redis restarts. We await so a
// crash mid-replay doesn't leave the worker happily processing
// non-schedule jobs while the schedule registrations are partially
// gone. Failures are logged-and-tolerated — `assertMigrationsApplied`
// is the only fail-fast at boot.
try {
  const count = await replayAllScheduleEntries();
  if (count > 0) console.log(`[schedule] replayed ${count} entries`);
} catch (err) {
  console.error("[schedule] replay failed", err);
}

// Register the usage_events writer once at boot. Every LLM call
// from the `ai` node and `agent` planner fires it fire-and-forget.
setUsageRecorder(recordUsage);

// Mirror of `setUsageRecorder` for the `email.send` tool. Tools fire
// from THIS worker (not the api), so the recorder MUST be registered
// here for `usage_events` rows with `metric: "email.sent"` to land.
setEmailUsageRecorder(recordEmailUsage);

// Sister to the email recorder, for slack.post / github.create_issue /
// webhook.send. Same usage_events chokepoint, distinct metric per tool.
setIntegrationUsageRecorder(recordIntegrationUsage);

// Sister recorder for pdf.generate. Quantity is the produced PDF byte
// length so the operator sees storage cost on the same chart.
setPdfUsageRecorder(recordPdfUsage);

// Inject the shared Redis-backed limiter into worker-side tool execution.
// This is the enforcement point for `email.send`, because workflow tools run
// inside the worker process, not on the API request path.
setEngineRateLimiter(async (bucket, orgId, options) => {
  await enforceWorkerRateLimit(orgId, { name: bucket, windowMs: options.windowMs, max: options.max });
});

// Wire the production AI cost budget checker for engine-side LLM call
// sites (the `ai` node executor + the `agent` planner). Block paths
// degrade to `{ mode: "fallback", aiError: "budget_exceeded" }` so the
// AI fallback contract is preserved. Fail-soft on internal errors.
setBudgetChecker(productionBudgetChecker);
console.log("[budget] checker registered (worker)");

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
    // Delayed wake-up jobs for `wait_until` nodes carry a different payload
    // shape than regular execution jobs — dispatch on `job.name` first.
    if (job.name === "wait-resume") {
      await handleWaitResume(job.data);
      return;
    }
    if (job.name === "schedule-trigger") {
      await handleScheduleTrigger(job.data, job.repeatJobKey);
      return;
    }
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
    await closeWorkerRateLimitRedis();
    console.log("[worker] drained, exiting");
    process.exit(0);
  } catch (error) {
    console.error("[worker] shutdown error", error);
    process.exit(1);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

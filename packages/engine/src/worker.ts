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
import { z } from "zod";

import { NodeSchema, type Workflow } from "@janusly/shared";
import { assertMigrationsApplied } from "@janusly/db/src/migrations";
import { setUsageRecorder } from "@janusly/ai";
import {
  recordEmailUsage,
  recordIntegrationUsage,
  recordMcpUsage,
  recordMemoryUsage,
  recordPdfUsage,
  recordUsage,
  setMemoryUsageRecorder,
  productionBudgetChecker,
} from "@janusly/data";
import { setEmailUsageRecorder } from "./email-usage";
import { setIntegrationUsageRecorder } from "./integration-usage";
import { setMcpUsageRecorder } from "./mcp-usage";
import { setPdfUsageRecorder } from "./pdf-usage";
import { setEngineRateLimiter } from "./rate-limit";
import { setBudgetChecker } from "./budget";
import { closeWorkerRateLimitRedis, enforceWorkerRateLimit } from "./rate-limit-redis";
import { closeWorkerRunEventRedis, registerWorkerRunEventPublisher } from "./run-event-redis";
import { closeWorkerCacheInvalidationSubscriber, startWorkerCacheInvalidationSubscriber } from "./cache-invalidation-redis";
import { connection } from "./queue";
import { WorkflowRuntime } from "./core/runtime";
import { PostgresExecutionStore } from "./adapters/postgres-execution-store";
import { BullMQQueueAdapter } from "./adapters/bullmq-queue-adapter";
import { executeNode } from "./execute-node";
import { handleWaitResume } from "./wait-until";
import { handleScheduleTrigger, replayAllScheduleEntries } from "./schedule-scheduler";
import {
  handleMemoryRetentionTrigger,
  MEMORY_RETENTION_JOB_NAME,
  registerMemoryRetentionScheduler,
} from "./memory-retention-scheduler";
import {
  handleMemoryBulkPurgeTrigger,
  MEMORY_BULK_PURGE_JOB_NAME,
} from "./memory-purge-scheduler";
import {
  AUDIT_LOGS_RETENTION_JOB_NAME,
  handleAuditLogsRetentionTrigger,
  registerAuditLogsRetentionScheduler,
} from "./audit-logs-retention-scheduler";
import {
  handleScimEventsRetentionTrigger,
  registerScimEventsRetentionScheduler,
  SCIM_EVENTS_RETENTION_JOB_NAME,
} from "./scim-events-retention-scheduler";
import {
  handleRetentionTrigger,
  registerRetentionScheduler,
  RETENTION_JOB_NAME,
} from "./retention-scheduler";
import {
  handleUpstreamHealthTrigger,
  registerUpstreamHealthScheduler,
  UPSTREAM_HEALTH_JOB_NAME,
} from "./upstream-health-poller";
import {
  CONFIDENCE_CALIBRATION_JOB_NAME,
  handleConfidenceCalibrationTrigger,
  registerConfidenceCalibrationScheduler,
} from "./confidence-calibration-scheduler";
import {
  handleStalledNodeReaperTrigger,
  registerStalledNodeReaperScheduler,
  STALLED_NODE_REAPER_JOB_NAME,
} from "./stalled-node-reaper";
import { parseWorkflowCached } from "./workflow-parse-cache";
import { loadRunWorkflowRaw } from "./persistence";
import { withSpan } from "./observability/tracer";
import { shutdownTracing } from "./observability/otel";

await assertMigrationsApplied();

// Subscribe before scheduler registration or job execution can populate an
// org-config snapshot. Redis faults degrade to the cache TTL rather than
// blocking the worker's startup path.
startWorkerCacheInvalidationSubscriber();

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

// Daily sweep that enforces per-row `retain_until` on the memory
// substrate. Global (non-tenant) recurring job — first one in the
// codebase, hence the `system:` id prefix. Cadence comes from
// `JANUSLY_MEMORY_RETENTION_CRON` env with a `0 3 * * *` UTC default;
// the helper validates + falls back to default on parse failure with
// a warn log. Failure to register is logged-and-tolerated for the
// same reason as the schedule replay above — a Redis blip at boot
// must not block the worker from processing the rest of the queue.
try {
  const registered = await registerMemoryRetentionScheduler();
  if (registered) console.log("[memory-retention] daily sweep scheduler registered");
} catch (err) {
  console.error("[memory-retention] scheduler registration failed", err);
}

// Two sibling retention sweeps for append-only tables that would
// otherwise grow unbounded (audit_logs ~10k rows/day, scim_processed_events
// ~10k events/day). Same `system:` id convention + never-throws shape as
// the memory-retention scheduler above; env knobs documented in
// AGENTS.md "Retention sweeps".
try {
  const registered = await registerAuditLogsRetentionScheduler();
  if (registered) console.log("[audit-logs-retention] daily sweep scheduler registered");
} catch (err) {
  console.error("[audit-logs-retention] scheduler registration failed", err);
}
try {
  const registered = await registerScimEventsRetentionScheduler();
  if (registered) console.log("[scim-events-retention] daily sweep scheduler registered");
} catch (err) {
  console.error("[scim-events-retention] scheduler registration failed", err);
}

// Per-org configurable retention sweep across the five high-volume tenant
// tables (run_events / audit_logs / usage_events / recovery_feedback /
// memory_entries). Reads each org's `retention.*` config bounds and
// honours the per-row `hold_until` legal-hold bypass. Same `system:` id
// convention + never-throws boot posture as the standalone sweeps above;
// runs at 05:00 UTC so it doesn't pile onto the same off-peak window.
try {
  const registered = await registerRetentionScheduler();
  if (registered) console.log("[retention] daily per-org sweep scheduler registered");
} catch (err) {
  console.error("[retention] scheduler registration failed", err);
}

// Upstream health poll sweep. Global (non-tenant) recurring job — `system:`
// id prefix. Fetches every enabled `upstream_health_sources` row through the
// `fetchHttpTarget` SSRF chokepoint at the per-source interval, then auto-pauses
// / resumes tagged workflows. FAIL-OPEN: an unreachable status page never
// pauses anything. Same never-throws boot posture as the retention sweeps.
try {
  const registered = await registerUpstreamHealthScheduler();
  if (registered) console.log("[upstream-health] poll scheduler registered");
} catch (err) {
  console.error("[upstream-health] scheduler registration failed", err);
}

// Confidence-calibration sweep. Global (non-tenant) recurring job —
// `system:` id prefix. Walks every opted-in org's recovery feedback and
// fits a per-approach linear curve that maps an LLM's self-rated patch
// confidence onto its observed accept rate. Opt-out per org via
// `org_configs.ai.confidenceCalibrationEnabled`. Same never-throws boot
// posture as the retention sweeps.
try {
  const registered = await registerConfidenceCalibrationScheduler();
  if (registered) console.log("[confidence-calibration] daily sweep scheduler registered");
} catch (err) {
  console.error("[confidence-calibration] scheduler registration failed", err);
}

// Stalled-node reaper. Global (non-tenant) recurring job — `system:` id
// prefix. Finds production-run nodes left `running` past the stall threshold
// (the signature of a worker that crashed mid-node, which the atomic claim
// cannot self-heal), fails them into the DLQ, and rolls their runs up to a
// terminal status so a dead worker can't leave a run stuck forever. Same
// never-throws boot posture as the retention sweeps.
try {
  const registered = await registerStalledNodeReaperScheduler();
  if (registered) console.log("[stalled-node-reaper] sweep scheduler registered");
} catch (err) {
  console.error("[stalled-node-reaper] scheduler registration failed", err);
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

// Sister recorder for external `mcp_tool` invocations. Workers run
// the actual tool calls, so the recorder MUST be registered here for
// `usage_events` rows with `metric: "tool.mcp.<alias>.<name>"` to
// land. Discovery (one-shot listTools) runs from the API process and
// uses the API-side recorder registration above.
setMcpUsageRecorder(recordMcpUsage);

// Sister recorder for memory commit/recall calls. Future engine
// consumers (memory-assisted recovery, agent recall) fire from
// workers, so the recorder MUST be registered here for
// `usage_events` rows with `metric: "memory.commit"` /
// `metric: "memory.recall"` to land.
setMemoryUsageRecorder(recordMemoryUsage);

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

// Bridge the run-event seam to Redis PUBLISH so node lifecycle events +
// terminal status flips written here fan out to live SSE subscribers in the
// API process. The worker is the primary event writer, so this is the
// load-bearing publisher registration.
registerWorkerRunEventPublisher();
console.log("[run-stream] publisher registered (worker)");

// Register the recovery-alerting dispatcher so DLQ inserts inside this
// worker process can fire alerts immediately (event-driven path). The
// scanner Worker for state-driven triggers lives in the API process; this
// registration only handles the in-process event hand-off.
const { setAlertDispatcher } = await import("@janusly/data/src/alert-dispatch");
const { dispatchAlert } = await import("./alerts/dispatcher");
setAlertDispatcher(dispatchAlert);
console.log("[alerts] dispatcher registered (worker)");

// Recovery-ownership creator. Worker is the primary DLQ writer, so the
// creator MUST be registered here to catch every worker-side insert.
const { setRecoveryItemCreator } = await import("@janusly/data/src/recovery-item-creator");
const { createRecoveryItemForDeadLetter } = await import("./recovery/recovery-item-hook");
setRecoveryItemCreator(async (event) => {
  await createRecoveryItemForDeadLetter({
    orgId: event.orgId,
    deadLetterId: event.deadLetterId,
    createdBy: event.createdBy ?? "system",
    workflowId: event.workflowId,
    errorSignature: event.errorSignature,
  });
});
console.log("[recovery-item] creator registered (worker)");

// Per-workflow severity-default resolver — worker shares the same seam
// so DLQ inserts on either process produce the right severity. The
// resolver reads `workflow_metadata` via the data repo and degrades to
// null on read failure inside the DI seam.
const { setRecoveryItemSeverityDefault } = await import("@janusly/data/src/recovery-item-severity-default");
const { getWorkflowMetadata } = await import("@janusly/data/src/workflowMetadataRepo");
setRecoveryItemSeverityDefault(async (orgId, workflowId) => {
  const metadata = await getWorkflowMetadata(orgId, workflowId);
  return metadata?.severityDefault ?? null;
});
console.log("[recovery-item] severity-default resolver registered (worker)");

const runtime = new WorkflowRuntime(
  new PostgresExecutionStore(),
  new BullMQQueueAdapter(),
  {
    execute: async ({ runId, node }) => {
      return executeNode({ runId, node });
    },
  }
);

type ResolvedJob =
  | { skip: true }
  | { skip: false; runId: string; node: z.infer<typeof NodeSchema>; workflow: Workflow };

/**
 * Resolve a slim `execute-node` job (`{ runId, nodeId }`) into the full
 * execution input. The workflow is NOT carried in the Redis payload — it is
 * reloaded from `runs.inputJson.workflow` (the authoritative snapshot,
 * updated on replay) and the node resolved by id. The content-addressed
 * `parseWorkflowCached` keeps the full-workflow Zod parse off the hot path
 * for byte-identical loads; a patched replay has different bytes and can
 * never hit a stale entry.
 *
 * Returns `{ skip: true }` when the run row is gone (deleted between enqueue
 * and execution) — a benign no-op that mirrors the pre-slim "claim fails →
 * skip" outcome. Genuine data corruption (missing/invalid workflow, unknown
 * node id) throws `UnrecoverableError` so the poisoned job lands in the DLQ
 * instead of retrying forever.
 */
async function resolveJobData(data: unknown): Promise<ResolvedJob> {
  if (!data || typeof data !== "object") {
    throw new UnrecoverableError("Invalid job data: not an object");
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.runId !== "string" || obj.runId.length === 0) {
    throw new UnrecoverableError("Invalid job data: missing runId");
  }
  if (typeof obj.nodeId !== "string" || obj.nodeId.length === 0) {
    throw new UnrecoverableError("Invalid job data: missing nodeId");
  }

  const { found, workflow: rawWorkflow } = await loadRunWorkflowRaw(obj.runId);
  if (!found) {
    // Run deleted between enqueue and execution — nothing to run.
    return { skip: true };
  }
  const parsed = parseWorkflowCached(rawWorkflow);
  if (!parsed.ok) {
    throw new UnrecoverableError(`Invalid workflow for run ${obj.runId}: ${parsed.error}`);
  }
  const node = parsed.workflow.nodes.find((candidate) => candidate.id === obj.nodeId);
  if (!node) {
    throw new UnrecoverableError(`Node ${obj.nodeId} not found in workflow for run ${obj.runId}`);
  }
  return { skip: false, runId: obj.runId, node, workflow: parsed.workflow };
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
    if (job.name === MEMORY_RETENTION_JOB_NAME) {
      await handleMemoryRetentionTrigger();
      return;
    }
    if (job.name === AUDIT_LOGS_RETENTION_JOB_NAME) {
      await handleAuditLogsRetentionTrigger();
      return;
    }
    if (job.name === SCIM_EVENTS_RETENTION_JOB_NAME) {
      await handleScimEventsRetentionTrigger();
      return;
    }
    if (job.name === RETENTION_JOB_NAME) {
      await handleRetentionTrigger();
      return;
    }
    if (job.name === UPSTREAM_HEALTH_JOB_NAME) {
      await handleUpstreamHealthTrigger();
      return;
    }
    if (job.name === CONFIDENCE_CALIBRATION_JOB_NAME) {
      await handleConfidenceCalibrationTrigger();
      return;
    }
    if (job.name === STALLED_NODE_REAPER_JOB_NAME) {
      await handleStalledNodeReaperTrigger();
      return;
    }
    // One-shot delayed job — scheduled on demand from the
    // `memory.consent.revoked` audit specialization in
    // `apps/api/src/routes/org-routes.ts`. No boot registration here:
    // the schedule lives in Redis until it fires, the worker just
    // dispatches when BullMQ delivers the matured job.
    if (job.name === MEMORY_BULK_PURGE_JOB_NAME) {
      await handleMemoryBulkPurgeTrigger(job.data);
      return;
    }
    const resolved = await resolveJobData(job.data);
    if (resolved.skip) return;
    const { runId, node, workflow } = resolved;
    await withSpan(
      "workflow.node.execute",
      () => runtime.executeQueuedNode({ runId, node, workflow }),
      { "run.id": runId, "node.id": node.id, "node.type": node.type },
    );
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
    await closeWorkerCacheInvalidationSubscriber();
    await closeWorkerRateLimitRedis();
    await closeWorkerRunEventRedis();
    await shutdownTracing().catch((error) => {
      console.warn("[otel] trace shutdown failed; worker resources still drained", error);
    });
    console.log("[worker] drained, exiting");
    process.exit(0);
  } catch (error) {
    console.error("[worker] shutdown error", error);
    process.exit(1);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

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
 *   3. Open independent workflow and maintenance BullMQ Workers on
 *      `connection` from `./queue`. Customer node payloads are
 *      validated with `NodeSchema.parse(job.data)` — bad payloads become
 *      `UnrecoverableError` so they go to the DLQ instead of retrying
 *      forever.
 *   4. SIGTERM/SIGINT drain BOTH Workers before shared resources close, so
 *      container restarts do not orphan nodes or interrupt maintenance.
 *
 * Invariants:
 * - Top-level await is intentional — the migration assertion is mandatory
 *   before any work happens.
 * - Don't bypass `BullMQQueueAdapter`'s DLQ composition. Failed-beyond-retry
 *   jobs must land in `dead_letters`.
 * - The signal handlers must keep closing both Workers so the project's
 *   "no orphan running nodes" and maintenance durability invariants survive.
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
  assertCredentialRootKeyUsable,
  getRateLimiterAdminHealth,
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
import {
  connection,
  maintenanceQueue,
  MAINTENANCE_QUEUE_NAME,
  workflowQueue,
  WORKFLOW_QUEUE_NAME,
} from "./queue";
import { WorkflowRuntime } from "./core/runtime";
import { PostgresExecutionStore } from "./adapters/postgres-execution-store";
import { BullMQQueueAdapter } from "./adapters/bullmq-queue-adapter";
import { executeNode } from "./execute-node";
import { handleWaitResume } from "./wait-until";
import { handleApprovalDeadlineArm, handleApprovalTimeout } from "./approval-timeout";
import { handleScheduleTrigger, replayAllScheduleEntries } from "./schedule-scheduler";
import {
  handleReplayCampaignStep,
  REPLAY_CAMPAIGN_STEP_JOB_NAME,
} from "./replay-campaign";
import {
  dispatchMaintenanceJob,
  registerAndMigrateMaintenanceSchedulers,
  resolveMaintenanceWorkerConcurrency,
} from "./maintenance-jobs";
import { parseWorkflowCached } from "./workflow-parse-cache";
import { loadRunWorkflowRaw } from "./persistence";
import { withSpan } from "./observability/tracer";
import { shutdownTracing } from "./observability/otel";
import {
  registerQueueObservables,
  registerRateLimiterObservables,
} from "./observability/metrics";
import {
  shutdownPrometheusMetrics,
  startPrometheusMetrics,
  WORKER_METRICS_DEFAULT_PORT,
} from "./observability/prometheus";
import {
  createMaintenanceQueueCountReader,
  createWorkflowQueueCountReader,
} from "./observability/queue-reader";

await assertMigrationsApplied();

// Fail fast on a malformed or unreadable credential root key — the key is
// otherwise loaded lazily, and a worker whose key differs from the API's
// would resolve managed credentials as silently missing at run time. An
// unset key stays legal (legacy environment-reference deployments).
console.log(
  assertCredentialRootKeyUsable().configured
    ? "[credential-secret-store] root key loaded"
    : "[credential-secret-store] no root key configured; managed credential resolution will fail closed",
);

await startPrometheusMetrics({ defaultPort: WORKER_METRICS_DEFAULT_PORT, processName: "worker" });
const queueMetricsReader = createWorkflowQueueCountReader();
const unregisterQueueMetrics = registerQueueObservables(queueMetricsReader.getCounts);
const maintenanceQueueMetricsReader = createMaintenanceQueueCountReader();
const unregisterMaintenanceQueueMetrics = registerQueueObservables(
  maintenanceQueueMetricsReader.getCounts,
  "maintenance",
);
const unregisterRateLimiterMetrics = registerRateLimiterObservables(
  () => getRateLimiterAdminHealth().degradedBuckets.length,
);

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
// and the credential root-key probe are the only fail-fasts at boot.
try {
  const count = await replayAllScheduleEntries();
  if (count > 0) console.log(`[schedule] replayed ${count} entries`);
} catch (err) {
  console.error("[schedule] replay failed", err);
}

// Register every system recurrence on the isolated maintenance queue. A
// successful replacement retires the same scheduler id from the legacy
// workflow queue; already-materialized legacy jobs remain safe because the
// workflow processor keeps the shared maintenance dispatcher during rollout.
const maintenanceRegistration = await registerAndMigrateMaintenanceSchedulers();
console.log(
  `[maintenance] ${maintenanceRegistration.registered} schedulers registered; `
    + `${maintenanceRegistration.retiredLegacy} legacy schedulers retired`,
);

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
    execute: async ({ runId, node, recoveryClaimToken }) => {
      return executeNode({ runId, node, recoveryClaimToken });
    },
  }
);

type ResolvedJob =
  | { skip: true }
  | {
      skip: false;
      runId: string;
      node: z.infer<typeof NodeSchema>;
      workflow: Workflow;
      attempt: number;
      publicationGeneration: number;
      recoveryClaimToken?: string;
    };

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
  if (
    obj.recoveryClaimToken !== undefined
    && (typeof obj.recoveryClaimToken !== "string" || obj.recoveryClaimToken.length === 0)
  ) {
    throw new UnrecoverableError("Invalid job data: invalid recoveryClaimToken");
  }
  if (
    obj.publicationGeneration !== undefined
    && (
      typeof obj.publicationGeneration !== "number"
      || !Number.isSafeInteger(obj.publicationGeneration)
      || obj.publicationGeneration < 0
    )
  ) {
    throw new UnrecoverableError("Invalid job data: invalid publicationGeneration");
  }
  const attempt = typeof obj.attempt === "number" && Number.isSafeInteger(obj.attempt) && obj.attempt > 0
    ? obj.attempt
    : 1;
  const publicationGeneration = typeof obj.publicationGeneration === "number"
    ? obj.publicationGeneration
    : 0;

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
  return {
    skip: false,
    runId: obj.runId,
    node,
    workflow: parsed.workflow,
    attempt,
    publicationGeneration,
    ...(typeof obj.recoveryClaimToken === "string" ? { recoveryClaimToken: obj.recoveryClaimToken } : {}),
  };
}

export const worker = new Worker(
  WORKFLOW_QUEUE_NAME,
  async (job) => {
    // Delayed wake-up jobs for `wait_until` nodes carry a different payload
    // shape than regular execution jobs — dispatch on `job.name` first.
    if (job.name === "wait-resume") {
      await handleWaitResume(job.data);
      return;
    }
    if (job.name === "approval-timeout") {
      await handleApprovalTimeout(job.data);
      return;
    }
    if (job.name === "approval-deadline-arm") {
      await handleApprovalDeadlineArm(job.data);
      return;
    }
    if (job.name === "schedule-trigger") {
      await handleScheduleTrigger(job.data, job.repeatJobKey, {
        id: job.id,
        timestamp: job.timestamp,
      });
      return;
    }
    if (job.name === REPLAY_CAMPAIGN_STEP_JOB_NAME) {
      await handleReplayCampaignStep(job.data);
      return;
    }
    // Rolling-upgrade compatibility only: future system jobs are published to
    // `maintenance-jobs`, but an older queue can still hold one materialized
    // recurrence or delayed purge. Drain it through the canonical dispatcher.
    if (await dispatchMaintenanceJob(job.name, job.data)) return;
    const resolved = await resolveJobData(job.data);
    if (resolved.skip) return;
    const { runId, node, workflow, attempt, recoveryClaimToken, publicationGeneration } = resolved;
    await withSpan(
      "workflow.node.execute",
      () => runtime.executeQueuedNode({
        runId,
        node,
        workflow,
        attempt,
        publicationGeneration,
        recoveryClaimToken,
      }),
      { "run.id": runId, "node.id": node.id, "node.type": node.type },
    );
  },
  {
    connection,
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 10),
  }
);

/** Low-concurrency worker isolated from customer workflow execution. */
export const maintenanceWorker = new Worker(
  MAINTENANCE_QUEUE_NAME,
  async (job) => {
    if (await dispatchMaintenanceJob(job.name, job.data)) return;
    throw new UnrecoverableError(`Unknown maintenance job: ${job.name}`);
  },
  {
    connection,
    concurrency: resolveMaintenanceWorkerConcurrency(process.env.MAINTENANCE_WORKER_CONCURRENCY),
  },
);

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] received ${signal}, draining in-flight jobs…`);
  const workerClosures = await Promise.allSettled([
    worker.close(),
    maintenanceWorker.close(),
  ]);
  let shutdownFailed = workerClosures.some((result) => result.status === "rejected");
  for (const result of workerClosures) {
    if (result.status === "rejected") console.error("[worker] drain failed", result.reason);
  }

  try {
    unregisterQueueMetrics();
    unregisterMaintenanceQueueMetrics();
    unregisterRateLimiterMetrics();
  } catch (error) {
    shutdownFailed = true;
    console.error("[worker] metric callback retirement failed", error);
  }

  const resourceClosures = await Promise.allSettled([
    closeWorkerCacheInvalidationSubscriber(),
    closeWorkerRateLimitRedis(),
    closeWorkerRunEventRedis(),
    queueMetricsReader.close(),
    maintenanceQueueMetricsReader.close(),
    workflowQueue.close(),
    maintenanceQueue.close(),
    shutdownPrometheusMetrics(),
    shutdownTracing(),
  ]);
  for (const result of resourceClosures) {
    if (result.status === "rejected") {
      shutdownFailed = true;
      console.error("[worker] resource shutdown failed", result.reason);
    }
  }

  if (connection.status !== "end") {
    try {
      await connection.quit();
    } catch (error) {
      shutdownFailed = true;
      console.error("[worker] BullMQ Redis shutdown failed", error);
    }
  }

  console.log(shutdownFailed ? "[worker] shutdown completed with errors" : "[worker] drained, exiting");
  process.exit(shutdownFailed ? 1 : 0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

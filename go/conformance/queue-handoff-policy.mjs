// Pure, side-effect-free BullMQ/Postgres handoff policy. The executable
// adapter lives in queue-handoff.mjs; keeping the verdict here makes every
// cutover rule deterministic and unit-testable without Redis or PostgreSQL.

export const NODE_ORACLE_COMMIT = "d26e273a9bfbb42b8326142ccb0765f3f6f0442c";

export const QUEUE_NAMES = Object.freeze([
  "workflow-nodes",
  "maintenance-jobs",
  "alerts-system",
  "auto-healing-system",
]);

export const OPEN_JOB_STATES = Object.freeze([
  "active",
  "waiting",
  "waiting-children",
  "delayed",
  "prioritized",
  "paused",
]);

const MAINTENANCE_SCHEDULERS = Object.freeze([
  ["system:identity-retention", "identity-retention-trigger"],
  ["system:memory-retention", "memory-retention-trigger"],
  ["system:audit-logs-retention", "audit-logs-retention-trigger"],
  ["system:scim-events-retention", "scim-events-retention-trigger"],
  ["system:retention", "retention-trigger"],
  ["system:upstream-health-poll", "upstream-health-poll-trigger"],
  ["system:confidence-calibration", "confidence-calibration-trigger"],
  ["system:stalled-node-reaper", "stalled-node-reaper-trigger"],
  ["system:waiting-checkpoint-reconciler", "waiting-checkpoint-reconciler-trigger"],
  ["system:queue-publication-reconciler", "queue-publication-reconciler-trigger"],
  ["system:subworkflow-terminal-reconciler", "subworkflow-terminal-reconciler-trigger"],
  ["system:workflow-rollout-reconciler", "workflow-rollout-reconciler-trigger"],
  ["system:replay-campaign-reconciler", "replay-campaign-reconciler-trigger"],
]);

export const MAINTENANCE_JOB_NAMES = Object.freeze(
  MAINTENANCE_SCHEDULERS.map(([, name]) => name),
);

const MAINTENANCE_BY_ID = new Map(MAINTENANCE_SCHEDULERS);
const MAINTENANCE_NAME_SET = new Set(MAINTENANCE_JOB_NAMES);

const FIXED_SCHEDULERS = Object.freeze({
  "alerts-system": new Map([
    ["system:alerts-scanner", "alerts-scan-trigger"],
  ]),
  "auto-healing-system": new Map([
    ["system:auto-healing-scanner", "auto-healing-scan-trigger"],
    ["system:auto-healing-watcher", "auto-healing-watch-trigger"],
  ]),
});

function issue(code, message, details = {}) {
  return { code, message, ...details };
}

function instant(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sameInstant(left, right) {
  const a = instant(left);
  const b = instant(right);
  return a !== null && b !== null && a === b;
}

function jobKey(runId, nodeId) {
  return `${runId}\u0000${nodeId}`;
}

/** Return the closed scheduler policy for one BullMQ scheduler row. */
export function classifyScheduler(queueName, scheduler) {
  const key = String(scheduler?.key ?? "");
  const name = String(scheduler?.name ?? "");
  if (queueName === "workflow-nodes") {
    if (key.startsWith("schedule:") && key.split(":").length === 4 && name === "schedule-trigger") {
      return { known: true, kind: "workflow_schedule" };
    }
    if (MAINTENANCE_BY_ID.get(key) === name) {
      return { known: true, kind: "legacy_maintenance" };
    }
    return { known: false, kind: "unknown" };
  }
  if (queueName === "maintenance-jobs") {
    return MAINTENANCE_BY_ID.get(key) === name
      ? { known: true, kind: "maintenance" }
      : { known: false, kind: "unknown" };
  }
  const fixed = FIXED_SCHEDULERS[queueName];
  return fixed?.get(key) === name
    ? { known: true, kind: "api_system" }
    : { known: false, kind: "unknown" };
}

/** Classify only job names the frozen Node worker can dispatch. */
export function classifyJob(queueName, name) {
  if (queueName === "workflow-nodes") {
    if (name === "execute-node") return "execution";
    if (name === "wait-resume") return "timer";
    if (name === "approval-deadline-arm") return "approval_arm";
    if (name === "approval-timeout") return "approval_timeout";
    if (name === "schedule-trigger") return "schedule_tick";
    if (name === "replay-campaign-step") return "replay_campaign";
    if (name === "memory-bulk-purge-trigger") return "memory_purge";
    if (MAINTENANCE_NAME_SET.has(name)) return "recreatable_system";
    return "unknown";
  }
  if (queueName === "maintenance-jobs") {
    if (name === "memory-bulk-purge-trigger") return "memory_purge";
    return MAINTENANCE_NAME_SET.has(name) ? "recreatable_system" : "unknown";
  }
  if (queueName === "alerts-system") {
    return name === "alerts-scan-trigger" ? "recreatable_system" : "unknown";
  }
  if (queueName === "auto-healing-system") {
    return name === "auto-healing-scan-trigger" || name === "auto-healing-watch-trigger"
      ? "recreatable_system"
      : "unknown";
  }
  return "unknown";
}

function validateWaitingJob(kind, job, checkpoint) {
  const errors = [];
  const identity = { queue: job.queue, jobId: job.id, jobName: job.name };
  if (!checkpoint || checkpoint.status !== "waiting") {
    errors.push(issue("waiting_checkpoint_missing", "Parked waiting delivery has no matching waiting node", identity));
    return errors;
  }
  if (kind === "timer") {
    if (checkpoint.waitingKind !== "timer" || checkpoint.wakeupReason !== "wait_until" ||
        !sameInstant(checkpoint.waitingTarget, checkpoint.wakeupAt)) {
      errors.push(issue("timer_checkpoint_invalid", "Timer delivery is not backed by an exact Go wait_until clock", identity));
    }
    return errors;
  }
  if (checkpoint.waitingKind !== "approval" || checkpoint.wakeupReason !== "approval_timeout" ||
      !sameInstant(checkpoint.waitingTarget, checkpoint.wakeupAt)) {
    errors.push(issue("approval_checkpoint_invalid", "Approval delivery is not backed by an exact Go approval_timeout clock", identity));
    return errors;
  }
  if (kind === "approval_timeout" && !sameInstant(job.data?.deadlineAt, checkpoint.waitingTarget)) {
    errors.push(issue("approval_generation_mismatch", "BullMQ approval deadline does not match the durable checkpoint generation", identity));
  }
  return errors;
}

/**
 * Evaluate a normalized snapshot. `node-to-go` is intentionally stricter:
 * all executable Node work must drain. `go-to-node` allows queued Go work
 * only when Node's durable publication reconciler can recreate its delivery.
 */
export function evaluateHandoff(snapshot) {
  const direction = snapshot?.direction;
  if (direction !== "node-to-go" && direction !== "go-to-node") {
    throw new Error(`Unsupported handoff direction: ${direction}`);
  }
  const blockers = [];
  const warnings = [];
  const database = snapshot.database ?? {};
  const waitingByKey = new Map(
    (database.waitingCheckpoints ?? []).map(row => [jobKey(row.runId, row.nodeId), row]),
  );
  const campaignIds = new Set(database.replayCampaignIds ?? []);
  const executionJobs = new Map();

  if (snapshot.inventoryTruncated) {
    blockers.push(issue("inventory_truncated", "The bounded inventory did not inspect every open job or scheduler"));
  }
  if (snapshot.inventoryUnstable) {
    blockers.push(issue("inventory_unstable", "BullMQ ownership changed while the cross-store snapshot was being captured"));
  }
  for (const queueName of snapshot.unknownQueueNames ?? []) {
    blockers.push(issue("unknown_queue", "An unreviewed BullMQ queue exists in the shared Redis namespace", { queue: queueName }));
  }
  for (const invalid of database.invalidWaitingCheckpoints ?? []) {
    blockers.push(issue("waiting_bridge_invalid", "A bounded Node waiting checkpoint lacks an exact Go wakeup", invalid));
  }
  for (const schedule of database.unarmedSchedules ?? []) {
    blockers.push(issue("schedule_bridge_invalid", "An enabled schedule lacks a Go next_fire_at clock", schedule));
  }

  for (const queue of snapshot.queues ?? []) {
    for (const repeatable of queue.repeatables ?? []) {
      blockers.push(issue("legacy_repeatable_present", "A deprecated BullMQ repeatable job is outside the reviewed Job Scheduler lifecycle", {
        queue: queue.name, repeatableKey: repeatable.key, jobName: repeatable.name,
      }));
    }
    for (const scheduler of queue.schedulers ?? []) {
      const policy = classifyScheduler(queue.name, scheduler);
      if (!policy.known) {
        blockers.push(issue("unknown_scheduler", "Unknown BullMQ scheduler blocks a fail-closed handoff", {
          queue: queue.name, schedulerKey: scheduler.key, schedulerName: scheduler.name,
        }));
      } else {
        blockers.push(issue("scheduler_present", "Recurring Node scheduler ownership has not been retired", {
          queue: queue.name, schedulerKey: scheduler.key, schedulerName: scheduler.name,
        }));
      }
    }
    for (const rawJob of queue.jobs ?? []) {
      const job = { ...rawJob, queue: queue.name };
      const kind = classifyJob(queue.name, job.name);
      if (kind === "unknown") {
        blockers.push(issue("unknown_job", "Unknown open BullMQ job blocks a fail-closed handoff", {
          queue: queue.name, jobId: job.id, jobName: job.name, state: job.state,
        }));
        continue;
      }
      if (job.state === "active") {
        blockers.push(issue("active_job", "An active BullMQ delivery still has Node ownership", {
          queue: queue.name, jobId: job.id, jobName: job.name,
        }));
        continue;
      }
      if (kind === "execution") {
        const data = job.data ?? {};
        executionJobs.set(jobKey(data.runId, data.nodeId), job);
        if (direction === "node-to-go") {
          blockers.push(issue("execution_job_present", "Executable Node delivery must drain before Go activation", {
            queue: queue.name, jobId: job.id, state: job.state,
          }));
        }
        continue;
      }
      if (kind === "schedule_tick") {
        blockers.push(issue("schedule_tick_present", "A materialized Node schedule tick could duplicate Go's durable clock", {
          queue: queue.name, jobId: job.id, state: job.state,
        }));
        continue;
      }
      if (kind === "timer" || kind === "approval_arm" || kind === "approval_timeout") {
        const data = job.data ?? {};
        blockers.push(...validateWaitingJob(kind, job, waitingByKey.get(jobKey(data.runId, data.nodeId))));
        continue;
      }
      if (kind === "replay_campaign") {
        const campaignId = String(job.data?.campaignId ?? "");
        if (!campaignId || !campaignIds.has(campaignId)) {
          blockers.push(issue("replay_campaign_missing", "Parked replay delivery has no durable campaign row", {
            queue: queue.name, jobId: job.id,
          }));
        }
        continue;
      }
      if (kind === "memory_purge" && !String(job.data?.orgId ?? "").trim()) {
        blockers.push(issue("memory_purge_invalid", "Parked memory purge has no bounded organization identity", {
          queue: queue.name, jobId: job.id,
        }));
        continue;
      }
      if (kind === "recreatable_system") {
        warnings.push(issue("parked_system_job", "A recognized idempotent system trigger remains parked for rollback", {
          queue: queue.name, jobId: job.id, jobName: job.name, state: job.state,
        }));
      }
    }
  }

  if ((database.runningNodes ?? 0) > 0) {
    blockers.push(issue("running_nodes", "PostgreSQL still contains running node claims", { count: database.runningNodes }));
  }
  const queuedNodes = database.queuedNodes ?? [];
  if (direction === "node-to-go" && queuedNodes.length > 0) {
    blockers.push(issue("queued_nodes", "Node drain left executable queued rows in a running run", { count: queuedNodes.length }));
  }
  if (direction === "go-to-node") {
    for (const node of queuedNodes) {
      const key = jobKey(node.runId, node.nodeId);
      const job = executionJobs.get(key);
      const jobMatches = job && Number(job.data?.attempt ?? 1) === Number(node.attempt ?? 1) &&
        Number(job.data?.publicationGeneration ?? 0) === Number(node.publicationGeneration ?? 0) &&
        String(job.data?.recoveryClaimToken ?? "") === String(node.recoveryClaimToken ?? "");
      if (!node.repairAfter && !jobMatches) {
        blockers.push(issue("rollback_publication_missing", "Queued Go work has neither a durable Node outbox marker nor an exact BullMQ delivery", {
          runId: node.runId, nodeId: node.nodeId,
        }));
      }
      if (node.wakeupReason === "retry" && !jobMatches &&
          (!node.repairAfter || !sameInstant(node.repairAfter, node.wakeupAt))) {
        blockers.push(issue("rollback_retry_clock_mismatch", "Go retry backoff is not mirrored into Node's publication deadline", {
          runId: node.runId, nodeId: node.nodeId,
        }));
      }
    }
  }

  return {
    pass: blockers.length === 0,
    direction,
    blockers,
    warnings,
  };
}

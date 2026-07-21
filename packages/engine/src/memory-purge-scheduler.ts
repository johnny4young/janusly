/**
 * Consent-revocation bulk-purge scheduler. When an admin flips
 * `org_configs.memory.enabled` from `true` to `false`, the canonical
 * memory policy promises every `memory_entries` row for the org is
 * purged within 7 days. This module is the BullMQ machinery that
 * enforces that promise — a delayed one-shot job per org with a
 * deterministic id, scheduled on revoke and cancelled on re-grant.
 *
 * Sister to `memory-retention-scheduler.ts`: that one is a recurring
 * daily cron (`upsertJobScheduler`); this one is a one-shot delayed
 * job (`maintenanceQueue.add` with `{ delay, jobId }`). Different BullMQ
 * primitives, same architectural posture — never throws, audit log is
 * the canonical observable signal, env-driven cadence with safe
 * fallback.
 *
 * Used by:
 * - `apps/api/src/routes/org-routes.ts` —
 *   `schedulePendingMemoryPurge` awaited after the
 *   `memory.consent.revoked` audit; `cancelPendingMemoryPurge`
 *   awaited before the `memory.consent.granted` audit so the
 *   `pendingPurgeCancelled` boolean rides the audit metadata.
 * - `apps/api/src/routes/memory-routes.ts` —
 *   `getMemoryPurgeStatus` powers the read-only consent transparency surface.
 * - `packages/engine/src/worker.ts` —
 *   `handleMemoryBulkPurgeTrigger` dispatched from the `Worker`
 *   constructor on `job.name === MEMORY_BULK_PURGE_JOB_NAME`. NO boot
 *   registration — one-shot jobs are scheduled on demand from the
 *   org-config route, not at boot.
 *
 * Invariants:
 * - The handler NEVER throws — a Postgres outage during the purge is
 *   caught + logged. BullMQ otherwise would retry the one-shot and
 *   amplify the noise; a missed purge is recoverable by an operator
 *   calling `purgeMemoryForOrg(orgId)` manually from a tsx REPL.
 * - The schedule / cancel helpers NEVER throw — a Redis blip during
 *   the org-config flip must not break the `org.config.updated`
 *   response. Returning `false` signals failure; the audit row's
 *   `pendingPurgeCancelled: false` records the operator-visible
 *   outcome. Queue calls are bounded because the BullMQ connection is
 *   tuned for workers (`maxRetriesPerRequest: null`) and can otherwise
 *   wait indefinitely during an outage.
 * - Defense-in-depth at fire time: the handler re-reads
 *   `org_configs.memory.enabled` and SKIPS the purge if the admin
 *   re-granted consent inside the 7-day window but the cancel call
 *   somehow failed. Cancellation is an optimization; safety lives in
 *   the handler.
 * - Deterministic, hashed per-org `jobId` means concurrent worker replicas
 *   booting at the same time + rapid revoke-grant-revoke cycles all
 *   converge on a single in-flight purge per org. The `schedule`
 *   helper removes any existing job FIRST before adding the new one
 *   so a previously-stuck job doesn't block a fresh schedule.
 */

import {
  getOrgConfigSnapshot,
  purgeMemoryForOrg,
} from "@janusly/data";
import { createHash } from "node:crypto";

import { maintenanceQueue, workflowQueue } from "./queue";

/** The `job.name` the worker dispatch matches on. */
export const MEMORY_BULK_PURGE_JOB_NAME = "memory-bulk-purge-trigger";

/** 7 days in milliseconds — the policy-documented bulk-purge window. */
export const DEFAULT_MEMORY_PURGE_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

/** Bound request-path queue calls so `/org/config` never waits forever on Redis. */
export const MEMORY_PURGE_QUEUE_TIMEOUT_MS = 5_000;

/**
 * Build the deterministic BullMQ job id for a given org. BullMQ rejects `:`
 * in custom one-shot job ids, and provider-issued org ids may contain other
 * reserved characters, so the tenant identity is represented by a bounded
 * SHA-256 digest. Scheduler ids use a different BullMQ API and keep their
 * existing colon-delimited format.
 */
export function buildMemoryPurgeJobId(orgId: string): string {
  const digest = createHash("sha256").update(orgId).digest("hex");
  return `memory-purge-${digest}`;
}

export type MemoryPurgeStatus =
  | { status: "none"; scheduledFor: null }
  | { status: "scheduled"; scheduledFor: string }
  | { status: "running"; scheduledFor: string | null }
  | { status: "unknown"; scheduledFor: null };

const PURGE_QUEUES = [
  { label: "maintenance", queue: maintenanceQueue },
  { label: "legacy-workflow", queue: workflowQueue },
] as const;

async function readMemoryPurgeJobStatus(
  job: Awaited<ReturnType<typeof maintenanceQueue.getJob>>,
): Promise<MemoryPurgeStatus> {
  if (!job) return { status: "none", scheduledFor: null };
  const state = await withQueueTimeout(job.getState(), "memory purge get job state");
  const scheduledAtMs = Number(job.timestamp) + Number(job.delay);
  const scheduledFor = Number.isFinite(scheduledAtMs)
    ? new Date(scheduledAtMs).toISOString()
    : null;

  if (state === "active") return { status: "running", scheduledFor };
  if (state === "delayed" || state === "waiting" || state === "waiting-children") {
    return scheduledFor
      ? { status: "scheduled", scheduledFor }
      : { status: "unknown", scheduledFor: null };
  }
  if (state === "completed" || state === "failed") return { status: "none", scheduledFor: null };
  return { status: "unknown", scheduledFor: null };
}

/**
 * Inspect the deterministic per-org purge job without exposing BullMQ or
 * Redis details to callers. Queue failures and unrecognised states degrade to
 * `unknown`; a transparency read must never leak infrastructure errors.
 */
export async function getMemoryPurgeStatus(input: {
  orgId: string;
}): Promise<MemoryPurgeStatus> {
  const jobId = buildMemoryPurgeJobId(input.orgId);
  const observed: MemoryPurgeStatus[] = [];
  let readFailed = false;
  try {
    for (const target of PURGE_QUEUES) {
      try {
        const job = await withQueueTimeout(
          target.queue.getJob(jobId),
          `memory purge get ${target.label} status job`,
        );
        observed.push(await readMemoryPurgeJobStatus(job));
      } catch (error) {
        readFailed = true;
        console.warn("[memory-purge] queue-specific status read failed", {
          orgId: input.orgId,
          queue: target.label,
          error,
        });
      }
    }
    return observed.find((status) => status.status === "running")
      ?? observed.find((status) => status.status === "scheduled")
      ?? observed.find((status) => status.status === "unknown")
      ?? (readFailed
        ? { status: "unknown", scheduledFor: null }
        : { status: "none", scheduledFor: null });
  } catch (err) {
    console.warn("[memory-purge] status read failed", { orgId: input.orgId, jobId, err });
    return { status: "unknown", scheduledFor: null };
  }
}

/**
 * Resolve the purge delay from env or fall back to the documented
 * 7-day default. Pure-functional over `env` so tests can pass a fake.
 *
 * Validation failure (missing value parses as not-an-integer, zero or
 * negative integer, non-finite) warn-logs and returns the default —
 * never throws. The org-config flip must not be blocked because of a
 * typo in a single env var.
 *
 * Staging operators expedite smokes by setting
 * `JANUSLY_MEMORY_PURGE_DELAY_MS=5000`; the warn log on every
 * non-default schedule call surfaces the configured value so a
 * staging-to-prod misconfig is visible.
 */
function resolveMemoryPurgeDelayMs(env: NodeJS.ProcessEnv): number {
  const raw = env.JANUSLY_MEMORY_PURGE_DELAY_MS?.trim();
  if (!raw) return DEFAULT_MEMORY_PURGE_DELAY_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    console.warn(
      "[memory-purge] JANUSLY_MEMORY_PURGE_DELAY_MS invalid; falling back to default",
      { value: raw, default: DEFAULT_MEMORY_PURGE_DELAY_MS },
    );
    return DEFAULT_MEMORY_PURGE_DELAY_MS;
  }
  return parsed;
}

function withQueueTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${MEMORY_PURGE_QUEUE_TIMEOUT_MS}ms`));
    }, MEMORY_PURGE_QUEUE_TIMEOUT_MS);
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Schedule a delayed bulk-purge job for the org. Idempotent via the
 * deterministic, BullMQ-safe per-org job id — concurrent worker
 * replicas booting at the same time re-schedule the same id, and
 * rapid revoke-grant-revoke cycles converge on the most recent
 * schedule.
 *
 * Removes any existing job with the same id FIRST before adding the
 * new one. This handles two edge cases: (1) a previously-scheduled
 * job that the cancel call quietly no-op'd (Redis blip), and
 * (2) BullMQ's `add(name, data, { jobId })` semantics — if a job
 * with the same id already exists, the add call silently ignores
 * the new opts, including `delay`. The explicit remove-then-add
 * sequence guarantees the freshest revoke wins.
 *
 * Returns `true` on success, `false` on bounded-timeout / Redis
 * failure. NEVER throws — the org-config flip path must not break
 * because of a transient Redis issue.
 *
 * Honesty note about `false`: `withQueueTimeout` races the queue call
 * against a 5s timer but does NOT cancel the underlying BullMQ
 * promise when the timer wins. A Redis reconnect after the helper
 * returned `false` could still land the job — the return value
 * signals "the API process did not confirm the schedule within the
 * timeout", not "definitely no job was enqueued". Operationally
 * harmless: the handler's fire-time consent re-check is the
 * load-bearing safety, and the next revoke's explicit remove-then-add
 * sequence reconverges deterministic-id state. A `false` return on
 * revoke is still the correct signal to surface in the warn log so
 * an operator knows the manual `purgeMemoryForOrg(orgId)` REPL
 * fallback may be needed.
 */
export async function schedulePendingMemoryPurge(input: {
  orgId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const env = input.env ?? process.env;
  const delay = resolveMemoryPurgeDelayMs(env);
  const jobId = buildMemoryPurgeJobId(input.orgId);
  try {
    // Best-effort removal of the existing job — if the org went
    // through a rapid revoke-grant-revoke cycle, this clears the
    // stale grant-cancelled-but-not-removed entry. Failure here is
    // logged but doesn't block the add: if remove fails AND the add's
    // jobId collides, the add silently keeps the older delay, which
    // is fail-safe (the next handler fire still re-checks consent).
    for (const target of PURGE_QUEUES) {
      try {
        const existing = await withQueueTimeout(
          target.queue.getJob(jobId),
          `memory purge get ${target.label} existing job`,
        );
        if (existing) {
          await withQueueTimeout(existing.remove(), `memory purge remove ${target.label} existing job`);
        }
      } catch (removeErr) {
        console.warn("[memory-purge] failed to remove pre-existing job before re-schedule", {
          orgId: input.orgId,
          jobId,
          queue: target.label,
          err: removeErr,
        });
      }
    }
    await withQueueTimeout(
      maintenanceQueue.add(
        MEMORY_BULK_PURGE_JOB_NAME,
        { orgId: input.orgId },
        {
          delay,
          jobId,
          attempts: 1,
          removeOnComplete: 100,
          // `removeOnFail: true` is load-bearing for the deterministic
          // jobId guarantee. The handler never throws, so in steady
          // state every job goes to `completed`. The edge case this
          // closes: a worker process crash MID-handler (before the
          // outer try/catch fires) would leave a `failed` job in Redis.
          // BullMQ's `queue.getJob(jobId)` does NOT retrieve jobs in
          // the `failed` state by default, so the next
          // `schedulePendingMemoryPurge` call's remove-then-add cycle
          // would silently no-op the remove, and BullMQ's `add` with a
          // colliding jobId silently keeps the OLDER (stale) entry —
          // the next revoke wouldn't schedule a fresh purge for that
          // org until an operator manually flushes Redis. With
          // `removeOnFail: true`, BullMQ drops the failed entry and
          // the deterministic-id slot is always free for the next
          // schedule call.
          removeOnFail: true,
        },
      ),
      "memory purge add job",
    );
    if (delay !== DEFAULT_MEMORY_PURGE_DELAY_MS) {
      console.warn("[memory-purge] using non-default delay (env override)", {
        orgId: input.orgId,
        delayMs: delay,
      });
    }
    return true;
  } catch (err) {
    console.error("[memory-purge] schedule failed", {
      orgId: input.orgId,
      jobId,
      err,
    });
    return false;
  }
}

/**
 * Cancel any pending bulk-purge job for the org. Idempotent — calling
 * on an org with no pending purge is a no-op. NEVER throws.
 *
 * Returns `true` if a job was found AND removed; `false` if no job
 * existed OR the remove operation failed. The boolean rides the
 * `memory.consent.granted` audit row's `pendingPurgeCancelled`
 * metadata so an operator reading the audit log immediately sees
 * "consent re-granted, by the way a pending purge was cancelled" (or
 * the false case: "no pending purge to cancel, either because none
 * was scheduled or the cancel failed").
 *
 * Invariant (AGENTS.md "Consent-revocation bulk purge"): callers MUST
 * await this before the `memory.consent.granted` audit row so the returned
 * boolean can accurately populate `pendingPurgeCancelled`.
 */
export async function cancelPendingMemoryPurge(input: {
  orgId: string;
}): Promise<boolean> {
  const jobId = buildMemoryPurgeJobId(input.orgId);
  let removed = false;
  for (const target of PURGE_QUEUES) {
    try {
      const existing = await withQueueTimeout(
        target.queue.getJob(jobId),
        `memory purge get ${target.label} pending job`,
      );
      if (!existing) continue;
      await withQueueTimeout(existing.remove(), `memory purge remove ${target.label} pending job`);
      removed = true;
    } catch (err) {
      console.warn("[memory-purge] cancel failed", {
        orgId: input.orgId,
        jobId,
        queue: target.label,
        err,
      });
    }
  }
  return removed;
}

/**
 * BullMQ handler. Re-reads `org_configs.memory.enabled` at fire time
 * and SKIPS the purge if the admin re-granted consent inside the
 * 7-day window. This is the defense-in-depth safety: a failed
 * cancellation (Redis blip when the admin re-granted) does NOT result
 * in a wipe of an actively-used org. Cancellation is an optimization;
 * safety lives here.
 *
 * On true-at-fire-time: log + return. The audit log carries the
 * `memory.consent.granted` row with `pendingPurgeCancelled: false` to
 * tell the operator "the cancel actually failed but the safety net
 * caught it".
 *
 * On false-at-fire-time: call `purgeMemoryForOrg(orgId)` (writes the
 * `memory.bulk.purged` audit row + returns counts) and log the
 * result.
 *
 * NEVER throws — a Postgres outage during the sweep is caught +
 * logged. BullMQ would otherwise mark the one-shot failed and amplify
 * via retry; an operator can re-run manually via REPL if needed.
 */
export async function handleMemoryBulkPurgeTrigger(data: {
  orgId: string;
}): Promise<void> {
  if (!data || typeof data.orgId !== "string" || !data.orgId) {
    console.error("[memory-purge] handler received malformed payload", { data });
    return;
  }
  try {
    const snapshot = await getOrgConfigSnapshot(data.orgId);
    if (snapshot.memory.enabled) {
      console.log(
        `[memory-purge] skipped — consent re-granted before purge fired (orgId=${data.orgId})`,
      );
      return;
    }
    const result = await purgeMemoryForOrg(data.orgId);
    console.log(
      `[memory-purge] bulk purge complete — orgId=${data.orgId} purged ${result.entriesPurged} entries`,
    );
  } catch (err) {
    console.error("[memory-purge] handler failed", { orgId: data.orgId, err });
  }
}

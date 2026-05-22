/**
 * Dedicated BullMQ Queue + Worker for the supervised auto-healing
 * scanner and watcher.
 *
 * Lives in the API process, not the engine worker, because the scan +
 * patch-suggestion handlers need access to the API-side helpers that
 * select per-node-type patch envelopes (`patchEnvelopeForNodeType`)
 * and merge patches into workflows (`applyConfigPatchToWorkflow`).
 * Those helpers cannot move down to `packages/engine` without a much
 * larger refactor of the AI schema layer.
 *
 * The queue is intentionally separate from the engine's
 * `workflow-nodes` queue. Sandbox validation runs that the scanner
 * enqueues still flow through `replayDeadLetterAsValidation` →
 * `workflow-nodes` and are executed by the engine worker; this queue
 * carries ONLY the cron-triggered scan + watch jobs.
 *
 * Used by:
 * - `apps/api/src/auto-healing-bootstrap.ts` — boot wiring that
 *   creates the Worker and registers the recurring schedulers.
 * - `apps/api/src/auto-healing-scanner.ts` — schedules itself onto
 *   this queue via `upsertJobScheduler`.
 * - `apps/api/src/auto-healing-watcher.ts` — sibling scheduler that
 *   polls validation outcomes.
 *
 * Invariants:
 * - Uses the same Redis connection BullMQ requires
 *   (`maxRetriesPerRequest: null` — re-exported as `connection` from
 *   `packages/engine/src/queue.ts`). Don't re-use the request-path
 *   `apps/api/src/redis.ts` client which has bounded retries.
 * - The Worker concurrency is 1: scans walk orgs sequentially and the
 *   watcher batches across rows, so there's no parallelism win from
 *   higher concurrency. One job at a time keeps the LLM rate-limit
 *   bucket math tractable.
 */

import { Queue } from "bullmq";
import { connection } from "@janusly/engine/src/queue";

export const AUTO_HEALING_QUEUE_NAME = "auto-healing-system";

export const autoHealingQueue = new Queue(AUTO_HEALING_QUEUE_NAME, { connection });

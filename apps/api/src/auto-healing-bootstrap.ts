/**
 * Boot wiring for the auto-healing subsystem. Called once from
 * `apps/api/src/index.ts` after route registration. Three things
 * happen:
 *
 *   1. Register the scanner scheduler (every 6h by default).
 *   2. Register the watcher scheduler (every minute by default).
 *   3. Open a BullMQ Worker on the dedicated `auto-healing-system`
 *      queue with concurrency 1.
 *
 * Skips entirely when `JANUSLY_AUTO_HEALING_ENABLED !== "true"`. A
 * fresh checkout with default env never registers anything; zero
 * Redis writes, zero Worker process.
 *
 * Invariants:
 * - Never throws. A Redis blip at boot logs and continues so the rest
 *   of the API process starts.
 * - The Worker is bound to the same `connection` BullMQ uses for the
 *   workflow-nodes queue, so the existing tuning applies.
 * - Concurrency 1: scans walk orgs sequentially; the watcher batches
 *   across rows. There's no parallelism win from higher concurrency.
 */

import { Worker, type Processor } from "bullmq";
import { connection } from "@janusly/engine/src/queue";

import {
  AUTO_HEALING_SCAN_JOB_NAME,
  handleAutoHealingScanTrigger,
  registerAutoHealingScannerScheduler,
} from "./auto-healing-scanner";
import {
  AUTO_HEALING_WATCH_JOB_NAME,
  handleAutoHealingWatchTrigger,
  registerAutoHealingWatcherScheduler,
} from "./auto-healing-watcher";
import { AUTO_HEALING_QUEUE_NAME } from "./auto-healing-queue";

let activeWorker: Worker | null = null;

const processor: Processor = async (job) => {
  if (job.name === AUTO_HEALING_SCAN_JOB_NAME) {
    await handleAutoHealingScanTrigger();
    return;
  }
  if (job.name === AUTO_HEALING_WATCH_JOB_NAME) {
    await handleAutoHealingWatchTrigger();
    return;
  }
};

/**
 * Boot the auto-healing subsystem. Idempotent — multiple calls in a
 * process keep the first Worker; subsequent registrations refresh
 * the cron pattern via the deterministic scheduler id.
 */
export async function bootstrapAutoHealing(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (env.JANUSLY_AUTO_HEALING_ENABLED !== "true") {
    return;
  }
  try {
    await registerAutoHealingScannerScheduler(env);
    await registerAutoHealingWatcherScheduler(env);
  } catch (err) {
    console.error("[auto-healing] scheduler registration failed", { err });
  }
  if (activeWorker) return;
  try {
    activeWorker = new Worker(AUTO_HEALING_QUEUE_NAME, processor, {
      connection,
      concurrency: 1,
    });
    activeWorker.on("error", (err) => {
      console.error("[auto-healing] worker error", { err });
    });
    activeWorker.on("failed", (job, err) => {
      console.error("[auto-healing] job failed", { name: job?.name, err });
    });
    console.log("[auto-healing] worker booted");
  } catch (err) {
    console.error("[auto-healing] worker open failed", { err });
  }
}

/**
 * Shutdown helper. Optional — Node process exit normally drains
 * BullMQ. Exposed so a process-manager teardown can drain explicitly.
 */
export async function shutdownAutoHealing(): Promise<void> {
  if (!activeWorker) return;
  try {
    await activeWorker.close();
  } catch (err) {
    console.error("[auto-healing] worker close failed", { err });
  }
  activeWorker = null;
}

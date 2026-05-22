/**
 * Boot wiring for the recovery alerting subsystem. Called once from
 * `apps/api/src/index.ts` after route registration (and once from
 * `packages/engine/src/worker.ts` so DLQ inserts inside the worker
 * process also reach the dispatcher).
 *
 * Three things happen:
 *
 *   1. Register the in-process dispatcher via `setAlertDispatcher` so
 *      event-driven hooks in engine + api + data fire immediately.
 *   2. Register the periodic scanner scheduler (cron via
 *      `JANUSLY_ALERTS_SCAN_CRON`, default every 2 min).
 *   3. Open a BullMQ Worker on the dedicated `alerts-system` queue with
 *      concurrency 1.
 *
 * Skips entirely when `JANUSLY_ALERTS_ENABLED !== "true"`. A fresh
 * checkout with default env never schedules anything; zero Redis writes,
 * zero Worker process.
 *
 * Invariants:
 * - Never throws. A Redis blip at boot logs and continues so the rest of
 *   the process starts.
 * - The Worker is bound to the same `connection` BullMQ uses for the
 *   workflow-nodes queue.
 * - Concurrency 1 — the scanner walks orgs sequentially; the dispatcher
 *   fans out one alert at a time within a scan.
 */

import { Worker, type Processor } from "bullmq";
import { connection } from "@janusly/engine/src/queue";
import { setAlertDispatcher } from "@janusly/data/src/alert-dispatch";

import { dispatchAlert } from "@janusly/engine/src/alerts/dispatcher";

import { ALERTS_QUEUE_NAME } from "./alerts/alerts-queue";
import {
  ALERTS_SCAN_JOB_NAME,
  handleAlertsScanTrigger,
  registerAlertsScannerScheduler,
} from "./alerts/scanner";

let activeWorker: Worker | null = null;

const processor: Processor = async (job) => {
  if (job.name === ALERTS_SCAN_JOB_NAME) {
    await handleAlertsScanTrigger();
    return;
  }
};

/**
 * Boot the alerting subsystem. Idempotent — multiple calls in a process
 * keep the first Worker; subsequent registrations refresh the scheduler
 * cron via the deterministic scheduler id.
 *
 * **The DI seam registration happens unconditionally** when this function
 * is called. The env gate only skips the scanner Worker. Why: event-driven
 * dispatch (DLQ inserts, budget block, limiter degraded) should fire when
 * policies exist even if the scanner Worker is intentionally disabled.
 * The DI seam is cheap; it only does anything when there's a policy match.
 */
export async function bootstrapAlerts(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  // Always register the dispatcher seam so event-driven hooks reach it.
  setAlertDispatcher(dispatchAlert);

  if (env.JANUSLY_ALERTS_ENABLED !== "true") return;

  try {
    await registerAlertsScannerScheduler(env);
  } catch (err) {
    console.error("[alerts] scheduler registration failed", { err });
  }

  if (activeWorker) return;
  try {
    activeWorker = new Worker(ALERTS_QUEUE_NAME, processor, {
      connection,
      concurrency: 1,
    });
    activeWorker.on("error", (err) => {
      console.error("[alerts] worker error", { err });
    });
    activeWorker.on("failed", (job, err) => {
      console.error("[alerts] job failed", { name: job?.name, err });
    });
    console.log("[alerts] worker booted");
  } catch (err) {
    console.error("[alerts] worker open failed", { err });
  }
}

/** Shutdown helper. Optional — Node process exit normally drains BullMQ. */
export async function shutdownAlerts(): Promise<void> {
  setAlertDispatcher(null);
  if (!activeWorker) return;
  try {
    await activeWorker.close();
  } catch (err) {
    console.error("[alerts] worker close failed", { err });
  }
  activeWorker = null;
}

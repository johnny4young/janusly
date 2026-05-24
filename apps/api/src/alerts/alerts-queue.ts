/**
 * Dedicated BullMQ Queue for the recovery alerting subsystem's state-driven
 * scanner job. Event-driven dispatches (DLQ insert, budget block, limiter
 * degradation) fire in-process via `setAlertDispatcher` — they do NOT go
 * through this queue.
 *
 * Lives in the API process (same pattern as `auto-healing-queue.ts`) and
 * reuses the engine's BullMQ Redis connection.
 *
 * Used by:
 *  - `apps/api/src/alerts-bootstrap.ts` — boots the Worker.
 *  - `apps/api/src/alerts/scanner.ts` — schedules itself via
 *    `upsertJobScheduler`.
 */

import { Queue } from "bullmq";
import { connection } from "@janusly/engine/src/queue";

export const ALERTS_QUEUE_NAME = "alerts-system";

export const alertsQueue = new Queue(ALERTS_QUEUE_NAME, { connection });

/**
 * BullMQ-backed `QueueAdapter` implementation. Hands ready-to-run nodes to
 * the BullMQ queue and composes `DeadLetterQueueAdapter` so the DLQ
 * insertion happens at the queue layer, not as an after-thought outside it.
 *
 * Used by `core/runtime.ts` (the only consumer of `QueueAdapter`).
 *
 * Invariants:
 * - DLQ composition is part of the queue contract — don't bypass
 *   `this.deadLetters` or insert into `dead_letters` from elsewhere.
 */

import { enqueueNode } from "../queue";
import type { QueueAdapter, EnqueueNodeInput, DeadLetterInput } from "../core/types";
import { DeadLetterQueueAdapter } from "./dead-letter-queue";

/** `QueueAdapter` implementation backed by BullMQ + Redis. */
export class BullMQQueueAdapter implements QueueAdapter {
  private deadLetters = new DeadLetterQueueAdapter();

  /** Enqueue a ready-to-run node onto the BullMQ workflow queue. */
  async enqueueNode(input: EnqueueNodeInput): Promise<void> {
    await enqueueNode(input);
  }

  /** Insert a row into `dead_letters` for a job that exhausted its retries. */
  async enqueueDeadLetter(input: DeadLetterInput): Promise<void> {
    await this.deadLetters.enqueueDeadLetter(input);
  }
}

/**
 * Dead-letter queue writer — inserts one row into `dead_letters` when a job
 * exhausts its retries. The adapter is composed into
 * `BullMQQueueAdapter` so DLQ insertion is part of the queue contract.
 *
 * Used by `adapters/bullmq-queue-adapter.ts` (and indirectly via
 * `core/runtime.ts`).
 *
 * Invariants:
 * - Stores the full `workflow` + `node` JSON so `/dlq/replay` can reconstruct
 *   the exact job payload — don't trim fields here.
 */

import { db } from "@janusly/db";
import { deadLetters } from "@janusly/db";
import type { DeadLetterInput, QueueAdapter } from "../core/types";

/** Persists exhausted-retry jobs to `dead_letters` for later replay or resolution. */
export class DeadLetterQueueAdapter implements Partial<QueueAdapter> {
  /** Insert one row capturing the full failed job payload. */
  async enqueueDeadLetter(input: DeadLetterInput): Promise<void> {
    await db.insert(deadLetters).values({
      id: crypto.randomUUID(),
      runId: input.runId,
      nodeId: input.node.id,
      attempt: input.attempt,
      workflowJson: input.workflow,
      nodeJson: input.node,
      errorJson: input.error,
    });

    console.error("[DLQ] node persisted to dead letters", {
      runId: input.runId,
      nodeId: input.node.id,
      attempt: input.attempt,
    });
  }
}

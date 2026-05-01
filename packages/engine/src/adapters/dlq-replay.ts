/**
 * Dead-letter replay adapter — re-enqueues a previously failed node from the
 * `dead_letters` row payload. Resets `attempt` to 1 so the BullMQ retry
 * machinery applies its own policy on the replayed run.
 *
 * Used by `apps/api/src/index.ts` `POST /dlq/replay` (after `requireRole`
 * gates editor on the calling user).
 *
 * Invariants:
 * - Multi-tenant scope is enforced by the route layer; this adapter trusts
 *   its caller resolved the org-scoped `dead_letters` row.
 */

import type { DeadLetterReplayAdapter, DeadLetterReplayInput } from "../core/types";
import { enqueueNode } from "../queue";

/** `DeadLetterReplayAdapter` implementation backed by the BullMQ queue. */
export class DLQReplayAdapter implements DeadLetterReplayAdapter {
  /** Re-enqueue the failed node with attempt counter reset to 1. */
  async replayDeadLetter(input: DeadLetterReplayInput): Promise<void> {
    const { runId, workflow, node } = input;

    console.log("[DLQ-REPLAY] Re-enqueue node", {
      runId,
      nodeId: node.id,
    });

    await enqueueNode({
      runId,
      workflow,
      node,
      attempt: 1,
    });
  }
}

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
import { safePersistPayload } from "../safe-persist";
import type { DeadLetterInput, QueueAdapter } from "../core/types";

// `errorJson` gets the regular 64 KB cap — errors carry serialized stacks
// + cause that occasionally include large request/response bodies, but
// 64 KB is enough for diagnosis and the chokepoint truncates the rest
// with a `__truncated` sentinel so the operator sees the overflow.
const DLQ_ERROR_JSON_MAX_BYTES = 64_000;

// `workflowJson` and `nodeJson` are persisted untruncated because the
// `/dlq/replay` endpoint reconstructs the exact failed job payload from
// these fields; trimming them would break replay. The chokepoint still
// runs key-redaction (so a literal `Authorization` field in
// `node.config.headers` is scrubbed) but skips the size step entirely.
const DLQ_PAYLOAD_NO_TRUNCATE = Number.POSITIVE_INFINITY;

/** Persists exhausted-retry jobs to `dead_letters` for later replay or resolution. */
export class DeadLetterQueueAdapter implements Partial<QueueAdapter> {
  /** Insert one row capturing the full failed job payload. */
  async enqueueDeadLetter(input: DeadLetterInput): Promise<void> {
    await db.insert(deadLetters).values({
      id: crypto.randomUUID(),
      runId: input.runId,
      nodeId: input.node.id,
      attempt: input.attempt,
      // Workflow + node JSONs are key-redacted (defense against literal
      // `Authorization` fields in the config) but never truncated —
      // `/dlq/replay` needs the exact failed job to reconstruct.
      workflowJson: safePersistPayload(input.workflow, { maxBytes: DLQ_PAYLOAD_NO_TRUNCATE }),
      nodeJson: safePersistPayload(input.node, { maxBytes: DLQ_PAYLOAD_NO_TRUNCATE }),
      errorJson: safePersistPayload(input.error, { maxBytes: DLQ_ERROR_JSON_MAX_BYTES }),
    });

    console.error("[DLQ] node persisted to dead letters", {
      runId: input.runId,
      nodeId: input.node.id,
      attempt: input.attempt,
    });
  }
}

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
import {
  recordAlertEvent,
  recordRecoveryItemCreationEvent,
} from "@janusly/data";
import { normalizeErrorSignature } from "@janusly/shared/src/error-signature";
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
    const deadLetterId = crypto.randomUUID();
    const workflowId = input.workflowId ?? input.workflow.id ?? null;
    await db.insert(deadLetters).values({
      id: deadLetterId,
      orgId: input.orgId,
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

    // Fire the recovery-alerting event hook. The DI seam in `@janusly/data`
    // is a no-op when no dispatcher is registered; production wiring in
    // `apps/api/src/alerts-bootstrap.ts` and `packages/engine/src/worker.ts`
    // registers `dispatchAlert` so subscribed policies fan out via Slack /
    // webhook / email / GitHub. Never blocks the DLQ insert.
    const errorSignature = normalizeErrorSignature(input.error, { nodeType: input.node.type }).signature;

    void recordAlertEvent({
      orgId: input.orgId,
      trigger: "dlq.entry_created",
      payload: {
        runId: input.runId,
        nodeId: input.node.id,
        workflowId,
        errorSignature,
      },
    });

    // Recovery-ownership: fire the seam that lets the api-side helper
    // create a `recovery_items` row idempotently. The api-side helper
    // honours `org_configs.recovery.autoCreateItems` and also fires the
    // `recovery_item.created` alert event when the row is genuinely new.
    void recordRecoveryItemCreationEvent({
      orgId: input.orgId,
      deadLetterId,
      workflowId,
      errorSignature,
      createdBy: "system",
    });
  }
}

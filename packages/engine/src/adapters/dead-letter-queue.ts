import { db } from "@workflow-engine/db";
import { deadLetters } from "@workflow-engine/db";
import type { DeadLetterInput, QueueAdapter } from "../core/types";

export class DeadLetterQueueAdapter implements Partial<QueueAdapter> {
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

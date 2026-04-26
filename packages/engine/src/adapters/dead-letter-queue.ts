import type { DeadLetterInput, QueueAdapter } from "../core/types";

export class DeadLetterQueueAdapter implements Partial<QueueAdapter> {
  async enqueueDeadLetter(input: DeadLetterInput): Promise<void> {
    // Minimal DLQ: log + future extension to persist or push to queue/topic
    console.error("[DLQ] node moved to dead letter", {
      runId: input.runId,
      nodeId: input.node.id,
      attempt: input.attempt,
      error: input.error,
    });
  }
}

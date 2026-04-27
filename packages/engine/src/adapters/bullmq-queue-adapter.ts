import { enqueueNode } from "../queue";
import type { QueueAdapter, EnqueueNodeInput, DeadLetterInput } from "../core/types";
import { DeadLetterQueueAdapter } from "./dead-letter-queue";

export class BullMQQueueAdapter implements QueueAdapter {
  private deadLetters = new DeadLetterQueueAdapter();

  async enqueueNode(input: EnqueueNodeInput): Promise<void> {
    await enqueueNode(input);
  }

  async enqueueDeadLetter(input: DeadLetterInput): Promise<void> {
    await this.deadLetters.enqueueDeadLetter(input);
  }
}

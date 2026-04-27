import { enqueueNode } from "../queue";
import type { QueueAdapter, EnqueueNodeInput } from "../core/types";

export class BullMQQueueAdapter implements QueueAdapter {
  async enqueueNode(input: EnqueueNodeInput): Promise<void> {
    await enqueueNode(input);
  }
}

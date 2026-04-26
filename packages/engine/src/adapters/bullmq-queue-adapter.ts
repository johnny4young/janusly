import { enqueueNode } from "../queue";
import type { QueueAdapter, EnqueueNodeInput } from "../core/types";

export class BullMQQueueAdapter implements QueueAdapter {
  enqueueNode(input: EnqueueNodeInput) {
    return enqueueNode(input);
  }
}

import type { DeadLetterReplayAdapter, DeadLetterReplayInput } from "../core/types";
import { enqueueNode } from "../queue";

export class DLQReplayAdapter implements DeadLetterReplayAdapter {
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
    } as any);
  }
}

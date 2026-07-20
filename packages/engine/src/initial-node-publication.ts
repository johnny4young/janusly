/**
 * Best-effort fast path for a node generation already committed to the
 * Postgres-to-BullMQ publication outbox.
 *
 * Used by initial production, validation, replay, and redrive run builders.
 * The durable database marker is authoritative: a Redis or acknowledgement
 * failure must not turn a committed run into an API failure or invite a
 * duplicate run. The queue-publication reconciler retries the exact
 * deterministic generation later.
 */

import { enqueueNode } from "./queue";
import { appendEvent, markQueuePublicationSucceeded } from "./persistence";

type PublicationDependencies = {
  enqueue: (input: Parameters<typeof enqueueNode>[0]) => Promise<unknown>;
  acknowledge: typeof markQueuePublicationSucceeded;
  appendQueuedEvent: (runId: string, nodeId: string, type: string, payload: unknown) => Promise<unknown>;
  warn: typeof console.warn;
};

export type InitialNodePublication = {
  runId: string;
  nodeId: string;
  attempt: number;
  publicationGeneration: number;
  recoveryClaimToken?: string;
  /** Preserve callers that intentionally emit a different replay event. */
  recordQueuedEvent?: boolean;
  eventPayload?: Record<string, unknown>;
};

/**
 * Attempt immediate publication without weakening the durable outbox.
 * Returns `false` when the reconciler still owns acknowledgement or delivery.
 */
export async function publishInitialNode(
  input: InitialNodePublication,
  overrides: Partial<PublicationDependencies> = {},
): Promise<boolean> {
  const deps: PublicationDependencies = {
    enqueue: overrides.enqueue ?? enqueueNode,
    acknowledge: overrides.acknowledge ?? markQueuePublicationSucceeded,
    appendQueuedEvent: overrides.appendQueuedEvent ?? appendEvent,
    warn: overrides.warn ?? console.warn,
  };
  let stage: "enqueue" | "acknowledge" = "enqueue";

  try {
    await deps.enqueue({
      runId: input.runId,
      nodeId: input.nodeId,
      attempt: input.attempt,
      publicationGeneration: input.publicationGeneration,
      ...(input.recoveryClaimToken ? { recoveryClaimToken: input.recoveryClaimToken } : {}),
    });
    stage = "acknowledge";
    const acknowledged = await deps.acknowledge(
      input.runId,
      input.nodeId,
      input.attempt,
      input.publicationGeneration,
      input.recoveryClaimToken,
    );
    if (!acknowledged) {
      deps.warn("[initial-node-publication] exact generation was not acknowledged", {
        runId: input.runId,
        nodeId: input.nodeId,
        stage,
      });
      return false;
    }
  } catch (error) {
    deps.warn("[initial-node-publication] immediate publication deferred", {
      runId: input.runId,
      nodeId: input.nodeId,
      stage,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return false;
  }

  if (input.recordQueuedEvent !== false) {
    try {
      await deps.appendQueuedEvent(input.runId, input.nodeId, "node.queued", input.eventPayload ?? {});
    } catch (error) {
      // Queue acceptance is the correctness boundary. A timeline write must
      // not report a committed, executable run as failed to its caller.
      deps.warn("[initial-node-publication] queued timeline event was not recorded", {
        runId: input.runId,
        nodeId: input.nodeId,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

  return true;
}

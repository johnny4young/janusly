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

import { db, deadLetters, runEvents, runNodes, runs } from "@janusly/db";
import {
  countConsecutiveWorkflowFailures,
  getOrgConfigSnapshot,
  getWorkflowBreakerStatus,
  recordAlertEvent,
  recordRecoveryItemCreationEvent,
  tripWorkflowCircuitBreaker,
} from "@janusly/data";
import { normalizeErrorSignature } from "@janusly/shared/src/error-signature";
import {
  isCircuitBreakerEnabled,
  readWorkflowCircuitBreaker,
  resolveCircuitBreakerThreshold,
  shouldTripCircuitBreaker,
} from "../core/circuit-breaker";
import { and, eq, isNull, sql } from "drizzle-orm";
import { safePersistPayload } from "../safe-persist";
import { notifyCommittedRunTerminal, terminalParentNotificationMarker } from "../persistence";
import { publishRunEvent } from "../run-event-stream";
import type {
  DeadLetterInput,
  QueueAdapter,
  SerializedError,
  TerminalFailureInput,
} from "../core/types";

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

/** Replay payload available for a stalled node whose run snapshot is valid. */
export type StalledDeadLetterPayload = {
  deadLetterId?: string;
  workflowId?: string | null;
  workflow: DeadLetterInput["workflow"];
  node: DeadLetterInput["node"];
};

/** Atomic stalled-node failure input used by the production reaper and drills. */
export type StalledTerminalFailureInput = {
  runId: string;
  orgId: string;
  nodeId: string;
  attempt: number;
  error: SerializedError;
  /** Null when a legacy run snapshot cannot reconstruct a replay-safe DLQ row. */
  deadLetter: StalledDeadLetterPayload | null;
  /** Bounded causal metadata added to the node.failed event. */
  eventMetadata?: Record<string, unknown>;
};

/** Result of one atomic stalled-node claim. */
export type StalledTerminalFailureResult = {
  persisted: boolean;
  deadLettered: boolean;
  deadLetterId: string | null;
};

type AtomicTerminalFailureInput = {
  runId: string;
  orgId: string;
  nodeId: string;
  attempt: number;
  error: SerializedError;
  deadLetter: DeadLetterInput | null;
  acceptedRunStatuses: readonly string[];
  enforceRecoveryClaim: boolean;
  recoveryClaimToken?: string;
  nodeEventMetadata?: Record<string, unknown>;
};

type AtomicTerminalFailureResult = StalledTerminalFailureResult & {
  runFlipped: boolean;
  failedNodes: number;
};

/** Persists exhausted-retry jobs to `dead_letters` for later replay or resolution. */
export class DeadLetterQueueAdapter implements Partial<QueueAdapter> {
  /**
   * Atomically commit an exhausted execution generation. The running-node
   * CAS, DLQ row, node.failed event, and first run.failed transition are one
   * Postgres transaction; a DLQ insert failure leaves the node eligible for
   * recovery instead of stranding a half-failed run.
   */
  async persistTerminalFailure(input: TerminalFailureInput): Promise<boolean> {
    const result = await this.persistAtomicTerminalFailure({
      runId: input.runId,
      orgId: input.orgId,
      nodeId: input.node.id,
      attempt: input.attempt,
      error: input.error,
      deadLetter: input,
      acceptedRunStatuses: ["running", "failed"],
      enforceRecoveryClaim: true,
      recoveryClaimToken: input.recoveryClaimToken,
    });
    return result.persisted;
  }

  /**
   * Atomically claim and terminate a stalled running node. A valid persisted
   * workflow snapshot adds the DLQ row in the same transaction; legacy or
   * malformed snapshots still commit the node event and parent-run failure.
   */
  async persistStalledTerminalFailure(
    input: StalledTerminalFailureInput,
  ): Promise<StalledTerminalFailureResult> {
    if (input.deadLetter && input.deadLetter.node.id !== input.nodeId) {
      throw new Error("stalled dead-letter node does not match the claimed node");
    }
    const deadLetter: DeadLetterInput | null = input.deadLetter
      ? {
          deadLetterId: input.deadLetter.deadLetterId,
          runId: input.runId,
          orgId: input.orgId,
          workflowId: input.deadLetter.workflowId,
          workflow: input.deadLetter.workflow,
          node: input.deadLetter.node,
          attempt: input.attempt,
          error: input.error,
        }
      : null;
    const result = await this.persistAtomicTerminalFailure({
      runId: input.runId,
      orgId: input.orgId,
      nodeId: input.nodeId,
      attempt: input.attempt,
      error: input.error,
      deadLetter,
      acceptedRunStatuses: ["created", "running", "waiting"],
      enforceRecoveryClaim: false,
      nodeEventMetadata: {
        ...(input.eventMetadata ?? {}),
        reason: "worker_stalled",
      },
    });
    return {
      persisted: result.persisted,
      deadLettered: result.deadLettered,
      deadLetterId: result.deadLetterId,
    };
  }

  /** Shared transaction and post-commit publication for every terminal path. */
  private async persistAtomicTerminalFailure(
    input: AtomicTerminalFailureInput,
  ): Promise<AtomicTerminalFailureResult> {
    const deadLetterId = input.deadLetter
      ? input.deadLetter.deadLetterId ?? crypto.randomUUID()
      : null;
    const workflowId = input.deadLetter
      ? input.deadLetter.workflowId ?? input.deadLetter.workflow.id ?? null
      : null;
    const failedAt = new Date();
    // `node.failed` is the causal failure and `run.failed` is its aggregate
    // consequence. Keep their keyset order explicit even though both commit in
    // one transaction; equal timestamps would otherwise fall back to random
    // UUID ordering and could put the run-level event first in the timeline.
    const runFailedAt = new Date(failedAt.getTime() + 1);
    const nodeEventId = crypto.randomUUID();
    const runEventId = crypto.randomUUID();
    const nodeEventPayload = safePersistPayload({
      ...(input.nodeEventMetadata ?? {}),
      // Fixed causal fields win over optional metadata so future callers
      // cannot accidentally rewrite the terminal error or attempt number.
      error: input.error,
      attempt: input.attempt,
    });

    const result = await db.transaction(async (tx) => {
      const [run] = await tx
        .select({ status: runs.status })
        .from(runs)
        .where(and(eq(runs.id, input.runId), eq(runs.orgId, input.orgId)))
        .limit(1)
        .for("update");
      if (!run || !input.acceptedRunStatuses.includes(run.status)) {
        return {
          persisted: false,
          deadLettered: false,
          deadLetterId: null,
          runFlipped: false,
          failedNodes: 0,
        };
      }

      const claimPredicate = input.enforceRecoveryClaim
        ? input.recoveryClaimToken
          ? eq(runNodes.recoveryClaimToken, input.recoveryClaimToken)
          : isNull(runNodes.recoveryClaimToken)
        : undefined;
      const [failedNode] = await tx
        .update(runNodes)
        .set({
          status: "failed",
          errorJson: safePersistPayload(input.error, { maxBytes: DLQ_ERROR_JSON_MAX_BYTES }),
          finishedAt: failedAt,
        })
        .where(and(
          eq(runNodes.runId, input.runId),
          eq(runNodes.nodeId, input.nodeId),
          eq(runNodes.status, "running"),
          ...(claimPredicate ? [claimPredicate] : []),
        ))
        .returning({ id: runNodes.id });
      if (!failedNode) {
        return {
          persisted: false,
          deadLettered: false,
          deadLetterId: null,
          runFlipped: false,
          failedNodes: 0,
        };
      }

      if (input.deadLetter && deadLetterId) {
        await tx.insert(deadLetters).values({
          id: deadLetterId,
          orgId: input.orgId,
          runId: input.runId,
          nodeId: input.nodeId,
          attempt: input.attempt,
          workflowJson: safePersistPayload(input.deadLetter.workflow, { maxBytes: DLQ_PAYLOAD_NO_TRUNCATE }),
          nodeJson: safePersistPayload(input.deadLetter.node, { maxBytes: DLQ_PAYLOAD_NO_TRUNCATE }),
          errorJson: safePersistPayload(input.error, { maxBytes: DLQ_ERROR_JSON_MAX_BYTES }),
          createdAt: failedAt,
        });
      }

      await tx.insert(runEvents).values({
        id: nodeEventId,
        runId: input.runId,
        nodeId: input.nodeId,
        type: "node.failed",
        payload: nodeEventPayload,
        createdAt: failedAt,
      });

      let runFlipped = false;
      let failedNodes = 1;
      if (run.status !== "failed") {
        const countRows = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(runNodes)
          .where(and(eq(runNodes.runId, input.runId), eq(runNodes.status, "failed")));
        failedNodes = Number(countRows[0]?.count ?? 1);
        const [flipped] = await tx
          .update(runs)
          .set({
            status: "failed",
            parentNotificationAfter: terminalParentNotificationMarker(),
          })
          .where(and(eq(runs.id, input.runId), eq(runs.status, run.status)))
          .returning({ id: runs.id });
        runFlipped = Boolean(flipped);
        if (runFlipped) {
          await tx.insert(runEvents).values({
            id: runEventId,
            runId: input.runId,
            nodeId: null,
            type: "run.failed",
            payload: safePersistPayload({ failedNodes }),
            createdAt: runFailedAt,
          });
        }
      }

      return {
        persisted: true,
        deadLettered: Boolean(input.deadLetter && deadLetterId),
        deadLetterId,
        runFlipped,
        failedNodes,
      };
    });

    if (!result.persisted) return result;

    publishRunEvent(input.runId, {
      kind: "event",
      id: nodeEventId,
      nodeId: input.nodeId,
      type: "node.failed",
      payload: nodeEventPayload,
      createdAt: failedAt.toISOString(),
    });
    if (result.runFlipped) {
      publishRunEvent(input.runId, {
        kind: "event",
        id: runEventId,
        nodeId: null,
        type: "run.failed",
        payload: safePersistPayload({ failedNodes: result.failedNodes }),
        createdAt: runFailedAt.toISOString(),
      });
      await notifyCommittedRunTerminal(input.runId, "failed");
    }
    publishRunEvent(input.runId, { kind: "run.status", status: "failed" });

    if (input.deadLetter && deadLetterId) {
      await this.afterDeadLetterCommitted({
        input: input.deadLetter,
        deadLetterId,
        workflowId,
      });
    }
    return result;
  }

  /** Fire non-transactional ownership and alert side effects after commit. */
  private async afterDeadLetterCommitted(input: {
    input: DeadLetterInput;
    deadLetterId: string;
    workflowId: string | null;
  }): Promise<void> {
    console.error("[DLQ] node persisted to dead letters", {
      runId: input.input.runId,
      nodeId: input.input.node.id,
      attempt: input.input.attempt,
    });

    // Fire the recovery-alerting event hook. The DI seam in `@janusly/data`
    // is a no-op when no dispatcher is registered; production wiring in
    // `apps/api/src/alerts-bootstrap.ts` and `packages/engine/src/worker.ts`
    // registers `dispatchAlert` so subscribed policies fan out via Slack /
    // webhook / email / GitHub. Never blocks the DLQ insert.
    const errorSignature = normalizeErrorSignature(input.input.error, {
      nodeType: input.input.node.type,
    }).signature;

    void recordAlertEvent({
      orgId: input.input.orgId,
      trigger: "dlq.entry_created",
      payload: {
        // The dead letter's own id is what makes the alert actionable: it is
        // the only handle that lets the notification link to THIS failure
        // instead of dropping the operator on a generic queue to hunt for it.
        deadLetterId: input.deadLetterId,
        runId: input.input.runId,
        nodeId: input.input.node.id,
        workflowId: input.workflowId,
        errorSignature,
      },
    });

    // Recovery-ownership: fire the seam that lets the api-side helper
    // create a `recovery_items` row idempotently. The api-side helper
    // honours `org_configs.recovery.autoCreateItems` and also fires the
    // `recovery_item.created` alert event when the row is genuinely new.
    await recordRecoveryItemCreationEvent({
      orgId: input.input.orgId,
      deadLetterId: input.deadLetterId,
      workflowId: input.workflowId,
      errorSignature,
      createdBy: "system",
    });

    await this.maybeTripCircuitBreaker(input);
  }

  /**
   * Recovery circuit breaker: N consecutive failed ordinary RUNS for
   * the same workflow pause it, so the operator authors the patch against a quiet
   * system instead of a DLQ that keeps filling — and the pre-failure
   * write-side effects stop re-firing on every scheduled tick.
   *
   * Never throws: a breaker fault must not corrupt the DLQ write that already
   * committed. Composes with the transient tier, which absorbs the failures
   * that heal, so a streak reaching here is a real, persistent break.
   */
  private async maybeTripCircuitBreaker(input: {
    input: DeadLetterInput;
    workflowId: string | null;
  }): Promise<void> {
    const workflowId = input.workflowId;
    // An ad-hoc run has no saved workflow to pause — nothing to contain.
    if (!workflowId) return;

    try {
      const { runs: runsConfig } = await getOrgConfigSnapshot(input.input.orgId);
      const threshold = resolveCircuitBreakerThreshold({
        workflowThreshold: readWorkflowCircuitBreaker(input.input.workflow),
        orgThreshold: runsConfig.circuitBreakerThreshold,
        enabled: isCircuitBreakerEnabled(),
      });
      if (threshold === null) return;

      const workflowStatus = await getWorkflowBreakerStatus(input.input.orgId, workflowId);
      if (workflowStatus === null) return; // deleted / tombstoned mid-flight

      const consecutiveFailures = await countConsecutiveWorkflowFailures(
        input.input.orgId,
        workflowId,
        threshold,
      );
      if (!shouldTripCircuitBreaker({ consecutiveFailures, threshold, workflowStatus })) return;

      const reason = `Circuit breaker: ${consecutiveFailures} consecutive failed runs`;
      const tripped = await tripWorkflowCircuitBreaker({
        orgId: input.input.orgId,
        workflowId,
        reason,
        consecutiveFailures,
        threshold,
        runId: input.input.runId,
      });
      // Only the worker that won the CAS announces it — concurrent workers
      // racing the same streak must not fan out duplicate pages.
      if (!tripped) return;

      console.error("[circuit-breaker] workflow paused", {
        orgId: input.input.orgId,
        workflowId,
        consecutiveFailures,
        threshold,
      });

      void recordAlertEvent({
        orgId: input.input.orgId,
        trigger: "workflow.circuit_breaker_tripped",
        payload: {
          workflowId,
          runId: input.input.runId,
          nodeId: input.input.node.id,
          consecutiveFailures,
          threshold,
        },
      });
    } catch (err) {
      // Containment is best-effort: the dead letter is already durable and the
      // operator still sees the failure. A breaker bug must never break the
      // DLQ path itself.
      console.error("[circuit-breaker] evaluation failed", {
        orgId: input.input.orgId,
        workflowId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Operator-driven release of a deterministic semantic quarantine.
 *
 * Persistence verifies and commits the decision first; downstream publication
 * then reuses the ordinary runtime queue path and its durable outbox.
 */

import { BullMQQueueAdapter } from "./adapters/bullmq-queue-adapter";
import { PostgresExecutionStore } from "./adapters/postgres-execution-store";
import { WorkflowRuntime } from "./core/runtime";
import {
  resolveSemanticOutcomeCase,
  type ResolveSemanticOutcomeCaseResult,
} from "./persistence";

let runtime: WorkflowRuntime | null = null;

function recoveryRuntime(): WorkflowRuntime {
  runtime ??= new WorkflowRuntime(
    new PostgresExecutionStore(),
    new BullMQQueueAdapter(),
    { execute: async () => ({}) },
  );
  return runtime;
}

export async function recoverSemanticOutcome(input: {
  orgId: string;
  caseId: string;
  actorId: string;
  decision: "replace" | "accept_loss";
  output?: unknown;
  reason: string;
}): Promise<ResolveSemanticOutcomeCaseResult> {
  const result = await resolveSemanticOutcomeCase(input);
  if (result.status !== "resolved") return result;
  if (result.resumed) {
    try {
      await recoveryRuntime().enqueueReadyNodes({
        runId: result.runId,
        workflow: result.workflow,
      });
    } catch (error) {
      // The resolution transaction marks pending rows for durable readiness
      // repair before returning. Immediate publication is only a latency
      // optimization, so a Redis or process failure must not make the
      // operator retry a decision that already committed.
      console.warn(
        "[semantic-recovery] immediate publication deferred",
        { runId: result.runId, error },
      );
    }
  }
  return result;
}

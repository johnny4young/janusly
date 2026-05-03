/**
 * `WorkflowRuntime` — the orchestrator that drives workflow execution from
 * "claim a node" through "emit completion event" and decides what comes next.
 *
 * Holds two adapters injected at construction:
 *   - `ExecutionStore` (today: `PostgresExecutionStore`) — persistence for
 *     `runs`, `run_nodes`, `run_events` plus the routing-stats update.
 *   - `QueueAdapter` (today: `BullMQQueueAdapter` composed with the DLQ
 *     adapter) — enqueueing the next node and routing terminal failures to
 *     `dead_letters`.
 *
 * Used by:
 * - `packages/engine/src/start-run.ts` — boots a new run via the runtime.
 * - `packages/engine/src/resume-run.ts` — resumes a paused run after an
 *   approval / webhook.
 * - `packages/engine/src/worker.ts` — `executeQueuedNode(runtime, job.data)`
 *   on every BullMQ message.
 *
 * Invariants:
 * - **Atomic node claim:** downstream nodes are claimed via
 *   `tryClaimNodeForQueue` (atomic `UPDATE ... WHERE status='pending'`). With
 *   multiple workers two predecessors can finish in the same instant; only
 *   one wins the claim. Don't reintroduce a non-atomic claim helper.
 * - **DLQ contract:** the queue adapter is wired to the DLQ adapter. Don't
 *   bypass the queue adapter to enqueue directly; failed-beyond-retry jobs
 *   must land in `dead_letters`.
 * - **Cross-panel reactivity:** mutations that invalidate server data must
 *   eventually trigger `bumpPlatformVersion()` on the web store — usually
 *   indirectly via the API's terminal-state response.
 * - **Audit logs:** every mutation that writes a `run_events` row carries
 *   the same shape the AI Studio consumes; don't change the event payload
 *   contract here without updating the engine event types and the web's
 *   `RunEvent` consumer.
 */

import { evaluateExpression } from "../expression";
import { logNodeEvent } from "../observability/logger";
import { workflowEvent } from "./events";
import { shouldRetry, computeRetryDelay } from "./retry-policy";
import { updateRoutingStats } from "@janusly/data/src/routingStatsRepo";
import { recordWorkflowImprovement } from "@janusly/data/src/improvementsRepo";
import { rollbackWorkflowVersion } from "@janusly/data/src/workflowRollbackRepo";
import { computeConfidence, shouldRollback } from "@janusly/domain/src/improvementEngine";
import type {
  ExecutionStore,
  QueueAdapter,
  NodeExecutorRegistry,
  ExecuteQueuedNodeInput,
  EnqueueReadyNodesInput,
  RetryPolicy,
  SerializedError,
} from "./types";

export class WorkflowRuntime {
  constructor(
    private readonly store: ExecutionStore,
    private readonly queue: QueueAdapter,
    private readonly executors: NodeExecutorRegistry,
  ) {}

  async executeQueuedNode(input: ExecuteQueuedNodeInput): Promise<void> {
    const { runId, node } = input;
    const attempt = input.attempt ?? 1;
    const start = Date.now();

    // Pre-execution cancellation guard: a run that has already reached a
    // terminal status (cancelled / failed) must NOT have its queued jobs
    // executed. Without this, a worker pulling a job from the BullMQ queue
    // for a cancelled run would re-flip the cancelled node back to running
    // and execute its body — defeating the cancellation.
    const preStatus = await this.store.getRunStatus(runId);
    if (preStatus === "cancelled" || preStatus === "failed") {
      await this.store.appendEvent(workflowEvent({
        runId, nodeId: node.id,
        type: "node.skipped",
        payload: { reason: `Run ${preStatus}`, attempt },
      }));
      return;
    }

    // Atomic `queued → running` claim. Defends against the race window
    // between the run-status read above and this UPDATE: if cancellation
    // lands in between, the conditional WHERE clause won't match the
    // now-cancelled row, the claim fails, and we emit a skip event.
    const claimed = await this.store.markNodeRunning(runId, node.id, attempt);
    if (!claimed) {
      await this.store.appendEvent(workflowEvent({
        runId, nodeId: node.id,
        type: "node.skipped",
        payload: { reason: "Node not in queued state", attempt },
      }));
      return;
    }
    await this.store.appendEvent(workflowEvent({ runId, nodeId: node.id, type: "node.running", payload: { attempt } }));

    try {
      const context = await this.store.getRunContext(runId);

      if (node.type === "router" || node.type === "router_llm") {
        const candidates = (node as any)?.config?.candidates ?? [];
        const rlStats = (context as any)?.rlStats;

        if (candidates.length > 0) {
          const { decide } = await import("@janusly/domain/src/decisionEngine");
          const decision = await decide({
            orgId: (context as any)?.orgId,
            candidates,
            preferences: (context as any)?.preferences,
            budget: (context as any)?.budget,
            rlStats,
          });

          await this.store.appendEvent(workflowEvent({ runId, nodeId: node.id, type: "decision.made", payload: decision }));
          logNodeEvent({ runId, nodeId: node.id, type: "decision.made", attempt });
          await this.store.markNodeSucceeded(runId, node.id, { decision });
          // Re-check run status before scheduling downstream work — a
          // cancellation that lands while this node was running shouldn't
          // re-queue work for the operator who just cancelled.
          const postDecisionStatus = await this.store.getRunStatus(runId);
          if (postDecisionStatus === "cancelled" || postDecisionStatus === "failed") return;
          await this.enqueueReadyNodes(input);
          return;
        }
      }

      const result = await this.executors.execute({ runId, node, context, attempt });
      const durationMs = Date.now() - start;

      if (result?.status === "waiting") {
        await this.store.markNodeWaiting(runId, node.id, result.metadata);
        await this.store.appendEvent(workflowEvent({ runId, nodeId: node.id, type: "node.waiting", payload: result }));
        logNodeEvent({ runId, nodeId: node.id, type: "node.waiting", attempt, durationMs });
        return;
      }

      await this.store.markNodeSucceeded(runId, node.id, result?.output ?? {});
      await updateRoutingStats({ orgId: (context as any)?.orgId, nodeId: node.id, reward: 1, success: true });
      await this.store.appendEvent(workflowEvent({ runId, nodeId: node.id, type: "node.succeeded", payload: { output: result?.output ?? {}, attempt } }));
      logNodeEvent({ runId, nodeId: node.id, type: "node.succeeded", attempt, durationMs });

      await this.evaluateImprovement(runId, context);

      // Re-check run status before scheduling downstream work. The node was
      // already running when cancellation landed, so its row stays where it
      // is — but downstream work shouldn't be queued for a cancelled run.
      const postStatus = await this.store.getRunStatus(runId);
      if (postStatus === "cancelled" || postStatus === "failed") return;

      await this.enqueueReadyNodes(input);
    } catch (err: any) {
      const durationMs = Date.now() - start;
      const context = await this.store.getRunContext(runId).catch(() => ({}));
      const error: SerializedError = { message: err.message, name: err.name, code: err.code, statusCode: err.statusCode };

      await updateRoutingStats({ orgId: (context as any)?.orgId, nodeId: node.id, reward: -1, success: false });

      const retryPolicy = (node as any)?.config?.retry as RetryPolicy | undefined;
      const maxAttempts = retryPolicy?.maxAttempts ?? 1;

      if (attempt < maxAttempts && shouldRetry(error, retryPolicy)) {
        const nextAttempt = attempt + 1;
        const delayMs = computeRetryDelay(nextAttempt, retryPolicy);
        const retryRunStatus = await this.store.getRunStatus(runId);
        if (retryRunStatus === "cancelled" || retryRunStatus === "failed") return;

        await this.store.markNodeQueued(runId, node.id, nextAttempt);
        await this.store.appendEvent(workflowEvent({ runId, nodeId: node.id, type: "node.retry", payload: { attempt: nextAttempt, delayMs, error } }));
        logNodeEvent({ runId, nodeId: node.id, type: "node.retry", attempt: nextAttempt, durationMs, error });

        await this.queue.enqueueNode({ runId, workflow: input.workflow, node, delayMs, attempt: nextAttempt });
        return;
      }

      if (this.queue.enqueueDeadLetter) {
        await this.queue.enqueueDeadLetter({ runId, workflow: input.workflow, node, attempt, error });
      }

      await this.store.markNodeFailed(runId, node.id, error);
      await this.store.appendEvent(workflowEvent({ runId, nodeId: node.id, type: "node.failed", payload: { error, attempt } }));
      logNodeEvent({ runId, nodeId: node.id, type: "node.failed", attempt, durationMs, error });
      await this.store.updateRunStatusFromNodes(runId);
      throw err;
    }
  }

  private async evaluateImprovement(runId: string, context: Record<string, unknown>) {
    const orgId = context?.orgId;
    const workflowId = context?.workflowId;
    if (typeof orgId !== "string" || typeof workflowId !== "string") return;

    const beforeMetrics = (context?.metricsBefore ?? {}) as Record<string, unknown>;
    const afterMetrics = (context?.metricsAfter ?? {}) as Record<string, unknown>;
    const { confidence, status } = computeConfidence(beforeMetrics, afterMetrics);

    await recordWorkflowImprovement({
      orgId,
      workflowId,
      baseVersion: typeof context.baseVersion === "number" ? context.baseVersion : undefined,
      newVersion: typeof context.newVersion === "number" ? context.newVersion : undefined,
      action: context.improvementAction,
      reason: "runtime_evaluation",
      beforeMetrics,
      afterMetrics,
      confidence,
      status,
    });

    await this.store.appendEvent(workflowEvent({ runId, type: "improvement.evaluated", payload: { workflowId, confidence, status } }));

    if (shouldRollback(confidence) && typeof context.baseVersion === "number") {
      await this.store.appendEvent(workflowEvent({ runId, type: "rollback.triggered", payload: { workflowId, confidence, status, targetVersion: context.baseVersion } }));

      const rollback = await rollbackWorkflowVersion({
        orgId,
        workflowId,
        targetVersion: context.baseVersion,
        createdBy: typeof context.createdBy === "string" ? context.createdBy : "system",
        reason: "auto-rollback: low confidence",
      });

      await this.store.appendEvent(workflowEvent({ runId, type: "rollback.completed", payload: rollback }));
    }
  }

  async enqueueReadyNodes(input: EnqueueReadyNodesInput): Promise<number> {
    const { runId, workflow } = input;
    // Defense-in-depth cancellation guard. Direct callers (subworkflow
    // notifier, resume-run, the runtime itself) all pre-check, but this
    // guard catches any future caller that forgets to.
    const status = await this.store.getRunStatus(runId);
    if (status === "cancelled" || status === "failed") return 0;
    const context = await this.store.getRunContext(runId);
    let queued = 0;

    for (const node of workflow.nodes) {
      const incomingEdges = workflow.edges.filter((edge) => edge.to === node.id);
      const deps = incomingEdges.map((edge) => edge.from);
      const depStatuses = await Promise.all(deps.map((depId) => this.store.getNodeStatus(runId, depId)));
      const ready = depStatuses.every((status) => ["succeeded", "skipped"].includes(status));
      const currentStatus = await this.store.getNodeStatus(runId, node.id);

      if (!ready || currentStatus !== "pending") continue;

      let shouldRun = false;
      for (const edge of incomingEdges) {
        if (!edge.condition) { shouldRun = true; break; }
        const result = evaluateExpression(edge.condition, { context, inputs: {} });
        if (result) { shouldRun = true; break; }
      }

      if (!shouldRun) {
        await this.store.markNodeSkipped(runId, node.id, { reason: "Condition not met" });
        await this.store.appendEvent(workflowEvent({ runId, nodeId: node.id, type: "node.skipped", payload: { reason: "Condition not met" } }));
        logNodeEvent({ runId, nodeId: node.id, type: "node.skipped" });
        continue;
      }

      const claimed = await this.store.tryClaimNodeForQueue(runId, node.id, 1);
      if (!claimed) continue;
      await this.queue.enqueueNode({ runId, workflow, node, attempt: 1 });
      await this.store.appendEvent(workflowEvent({ runId, nodeId: node.id, type: "node.queued" }));
      logNodeEvent({ runId, nodeId: node.id, type: "node.queued", attempt: 1 });
      queued++;
    }

    if (queued === 0) {
      await this.store.updateRunStatusFromNodes(runId);
      await this.store.appendEvent(workflowEvent({ runId, type: "run.status_checked" }));
    }

    return queued;
  }
}

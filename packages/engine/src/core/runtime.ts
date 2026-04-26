import { evaluateExpression } from "../expression";
import { logNodeEvent } from "../observability/logger";
import { workflowEvent } from "./events";
import { shouldRetry, computeRetryDelay } from "./retry-policy";
import { updateRoutingStats } from "@workflow-engine/data/src/routingStatsRepo";
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

    await this.store.markNodeRunning(runId, node.id, attempt);
    await this.store.appendEvent(workflowEvent({ runId, nodeId: node.id, type: "node.running", payload: { attempt } }));

    try {
      const context = await this.store.getRunContext(runId);

      if (node.type === "router" || node.type === "router_llm") {
        const candidates = (node as any)?.config?.candidates ?? [];
        const rlStats = (context as any)?.rlStats;

        if (candidates.length > 0) {
          const { decide } = await import("@workflow-engine/domain/src/decisionEngine");
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

  async enqueueReadyNodes(input: EnqueueReadyNodesInput): Promise<number> {
    const { runId, workflow } = input;
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

      await this.store.markNodeQueued(runId, node.id, 1);
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

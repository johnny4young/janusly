import { evaluateExpression } from "../expression";
import { shouldRetry, computeRetryDelay } from "./retry-policy";
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
    private readonly executors: NodeExecutorRegistry
  ) {}

  async executeQueuedNode(input: ExecuteQueuedNodeInput): Promise<void> {
    const { runId, node } = input;
    const attempt = input.attempt ?? 1;

    await this.store.markNodeRunning(runId, node.id, attempt);
    await this.store.appendEvent({ runId, nodeId: node.id, type: "node.running", payload: { attempt } });

    try {
      const context = await this.store.getRunContext(runId);

      const result = await this.executors.execute({
        runId,
        node,
        context,
        attempt,
      });

      if (result?.status === "waiting") {
        await this.store.markNodeWaiting(runId, node.id, result.metadata);
        await this.store.appendEvent({ runId, nodeId: node.id, type: "node.waiting", payload: result });
        return;
      }

      await this.store.markNodeSucceeded(runId, node.id, result?.output ?? {});
      await this.store.appendEvent({ runId, nodeId: node.id, type: "node.succeeded", payload: { output: result?.output ?? {}, attempt } });

      await this.enqueueReadyNodes(input);

    } catch (err: any) {
      const error: SerializedError = {
        message: err.message,
        name: err.name,
        code: err.code,
        statusCode: err.statusCode,
      };

      const retryPolicy = (node as any)?.config?.retry as RetryPolicy | undefined;
      const maxAttempts = retryPolicy?.maxAttempts ?? 1;

      if (attempt < maxAttempts && shouldRetry(error, retryPolicy)) {
        const nextAttempt = attempt + 1;
        const delayMs = computeRetryDelay(nextAttempt, retryPolicy);

        await this.store.appendEvent({
          runId,
          nodeId: node.id,
          type: "node.retry",
          payload: { attempt: nextAttempt, delayMs, error },
        });

        await this.queue.enqueueNode({
          runId,
          workflow: input.workflow,
          node,
          delayMs,
          attempt: nextAttempt,
        });

        return;
      }

      await this.store.markNodeFailed(runId, node.id, error);
      await this.store.appendEvent({ runId, nodeId: node.id, type: "node.failed", payload: { error, attempt } });
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
        if (!edge.condition) {
          shouldRun = true;
          break;
        }

        const result = evaluateExpression(edge.condition, {
          context,
          inputs: {},
        });

        if (result) {
          shouldRun = true;
          break;
        }
      }

      if (!shouldRun) {
        await this.store.markNodeSkipped(runId, node.id, { reason: "Condition not met" });
        continue;
      }

      await this.store.markNodeQueued(runId, node.id, 1);
      await this.queue.enqueueNode({ runId, workflow, node, attempt: 1 });
      await this.store.appendEvent({ runId, nodeId: node.id, type: "node.queued" });
      queued++;
    }

    if (queued === 0) {
      await this.store.updateRunStatusFromNodes(runId);
    }

    return queued;
  }
}

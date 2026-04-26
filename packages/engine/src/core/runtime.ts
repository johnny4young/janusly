import { evaluateExpression } from "../expression";
import type {
  ExecutionStore,
  QueueAdapter,
  NodeExecutorRegistry,
  ExecuteQueuedNodeInput,
  EnqueueReadyNodesInput,
} from "./types";

export class WorkflowRuntime {
  constructor(
    private readonly store: ExecutionStore,
    private readonly queue: QueueAdapter,
    private readonly executors: NodeExecutorRegistry
  ) {}

  async executeQueuedNode(input: ExecuteQueuedNodeInput): Promise<void> {
    const { runId, node } = input;

    await this.store.markNodeRunning(runId, node.id);
    await this.store.appendEvent({ runId, nodeId: node.id, type: "node.running" });

    try {
      const context = await this.store.getRunContext(runId);

      const result = await this.executors.execute({
        runId,
        node,
        context,
      });

      if (result?.status === "waiting") {
        await this.store.markNodeWaiting(runId, node.id, result.metadata);
        await this.store.appendEvent({ runId, nodeId: node.id, type: "node.waiting", payload: result });
        return;
      }

      await this.store.markNodeSucceeded(runId, node.id, result?.output ?? {});
      await this.store.appendEvent({ runId, nodeId: node.id, type: "node.succeeded", payload: { output: result?.output ?? {} } });

      await this.enqueueReadyNodes(input);

    } catch (err: any) {
      await this.store.markNodeFailed(runId, node.id, { message: err.message });
      await this.store.appendEvent({ runId, nodeId: node.id, type: "node.failed", payload: { message: err.message } });
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

      await this.store.markNodeQueued(runId, node.id);
      await this.queue.enqueueNode({ runId, workflow, node });
      await this.store.appendEvent({ runId, nodeId: node.id, type: "node.queued" });
      queued++;
    }

    if (queued === 0) {
      await this.store.updateRunStatusFromNodes(runId);
    }

    return queued;
  }
}

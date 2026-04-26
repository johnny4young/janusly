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
    // Minimal placeholder implementation (delegation will be migrated from scheduler)
    // This method will be expanded in next commits
    return 0;
  }
}

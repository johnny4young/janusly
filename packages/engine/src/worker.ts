import { Worker } from "bullmq";
import { connection } from "./queue";
import { executeNode } from "./execute-node";
import { markNodeRunning, markNodeSucceeded, markNodeFailed, appendEvent } from "./persistence";
import { enqueueNextNodes } from "./scheduler";

export const worker = new Worker(
  "workflow-nodes",
  async (job) => {
    const { runId, node, workflow } = job.data;

    await markNodeRunning(runId, node.id);

    try {
      await executeNode({ runId, node });

      await markNodeSucceeded(runId, node.id);
      await appendEvent(runId, node.id, "node.succeeded", {});

      await enqueueNextNodes({ runId, workflow });

    } catch (err: any) {
      await markNodeFailed(runId, node.id, { message: err.message });
      await appendEvent(runId, node.id, "node.failed", { message: err.message });

      throw err;
    }
  },
  {
    connection,
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 10),
  }
);

import { Queue } from "bullmq";
import IORedis from "ioredis";

export const connection = new IORedis(process.env.REDIS_URL!, {
  maxRetriesPerRequest: null,
});

export const workflowQueue = new Queue("workflow-nodes", {
  connection,
});

export async function enqueueNode(payload: any) {
  return workflowQueue.add("execute-node", payload, {
    attempts: 5,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: 1000,
  });
}

import { Queue } from "bullmq";
import IORedis from "ioredis";
import { loadRootEnv } from "@workflow-engine/db";
import type { EnqueueNodeInput } from "./core/types";

loadRootEnv();

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  throw new Error("Missing REDIS_URL. Add it to .env or .env.example.");
}

export const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
});

export const workflowQueue = new Queue("workflow-nodes", {
  connection,
});

export async function enqueueNode(payload: EnqueueNodeInput) {
  return workflowQueue.add("execute-node", payload, {
    attempts: 1,
    delay: payload.delayMs ?? 0,
    removeOnComplete: 1000,
  });
}

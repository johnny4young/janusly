/** Real-Redis proof for physical node-publication identity. */

import { Queue } from "bullmq";
import IORedis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadRootEnv } from "@janusly/db";
import { buildExecuteNodeJobId } from "../queue-job-id";

loadRootEnv();
const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error("REDIS_URL is required for queue integration tests");

const queueName = `it-queue-publication-${Date.now()}-${process.pid}`;
const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
const queue = new Queue(queueName, { connection });

beforeAll(async () => {
  await queue.waitUntilReady();
});

afterAll(async () => {
  await queue.obliterate({ force: true });
  await queue.close();
  await connection.quit();
});

describe("BullMQ physical publication generation (real Redis)", () => {
  it("deduplicates a producer retry but accepts a rotated redelivery", async () => {
    const base = {
      runId: "run-1",
      nodeId: "node-1",
      attempt: 1,
      recoveryClaimToken: "recovery-1",
    };
    const firstId = buildExecuteNodeJobId({ ...base, publicationGeneration: 7 });
    const redeliveryId = buildExecuteNodeJobId({ ...base, publicationGeneration: 8 });

    await queue.add("execute-node", { ...base, publicationGeneration: 7 }, { jobId: firstId });
    await queue.add("execute-node", { ...base, publicationGeneration: 7 }, { jobId: firstId });
    expect(await queue.getWaitingCount()).toBe(1);

    await queue.add("execute-node", { ...base, publicationGeneration: 8 }, { jobId: redeliveryId });
    expect(await queue.getWaitingCount()).toBe(2);
    await expect(queue.getJob(firstId)).resolves.not.toBeNull();
    await expect(queue.getJob(redeliveryId)).resolves.not.toBeNull();
  });
});

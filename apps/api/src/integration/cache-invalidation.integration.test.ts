/**
 * Real-Redis coverage for tenant cache invalidation delivery across API
 * replicas. The unit tests cover parsing and fail-open behavior; this suite
 * proves that two independent subscriber connections receive the same
 * published message.
 */

import IORedis from "ioredis";
import { afterEach, describe, expect, it } from "vitest";

import { createCacheInvalidationBus } from "../cache-invalidation-bus";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const clients: IORedis[] = [];

function openRedis(): IORedis {
  const client = new IORedis(redisUrl, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy: () => null,
  });
  client.on("error", () => {});
  clients.push(client);
  return client;
}

async function waitFor(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

afterEach(async () => {
  const closing = clients.splice(0);
  await Promise.all(
    closing.map(async (client) => {
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    }),
  );
});

describe("cache invalidation delivery (real Redis)", () => {
  it("converges both API replicas for config and recovery-metrics mutations", async () => {
    const publisherA = openRedis();
    const publisherB = openRedis();
    const subscriberA = openRedis();
    const subscriberB = openRedis();
    const seen = {
      a: { config: [] as string[], metrics: [] as string[] },
      b: { config: [] as string[], metrics: [] as string[] },
    };
    const replicaA = createCacheInvalidationBus({
      publisher: publisherA,
      getSubscriber: () => subscriberA,
      invalidateRecoveryMetrics: (orgId) => seen.a.metrics.push(orgId),
      invalidateOrgConfig: (orgId) => seen.a.config.push(orgId),
    });
    const replicaB = createCacheInvalidationBus({
      publisher: publisherB,
      getSubscriber: () => subscriberB,
      invalidateRecoveryMetrics: (orgId) => seen.b.metrics.push(orgId),
      invalidateOrgConfig: (orgId) => seen.b.config.push(orgId),
    });

    await Promise.all([replicaA.start(), replicaB.start()]);

    replicaA.publish({ kind: "org-config", orgId: "org-config" });
    await waitFor(
      () => seen.a.config.includes("org-config") && seen.b.config.includes("org-config"),
      "org-config delivery to both replicas",
    );

    replicaB.publish({ kind: "recovery-metrics", orgId: "org-metrics" });
    await waitFor(
      () => seen.a.metrics.includes("org-metrics") && seen.b.metrics.includes("org-metrics"),
      "recovery-metrics delivery to both replicas",
    );

    expect(seen).toEqual({
      a: { config: ["org-config"], metrics: ["org-metrics"] },
      b: { config: ["org-config"], metrics: ["org-metrics"] },
    });
  });
});

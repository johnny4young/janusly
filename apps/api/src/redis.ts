import IORedis from "ioredis";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

// Separate from `packages/engine/src/queue.ts` which sets
// `maxRetriesPerRequest: null` for BullMQ. The API's request-path Redis ops
// want bounded retries so a sick Redis doesn't pin a request indefinitely.
export const redis = new IORedis(redisUrl, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
});

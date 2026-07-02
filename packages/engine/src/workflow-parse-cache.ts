/**
 * Content-addressed cache for `WorkflowSchema.safeParse` in the worker's
 * job-validation path.
 *
 * Every `execute-node` BullMQ job carries the FULL workflow JSON, so a
 * 100-node workflow pays a full-workflow Zod parse 100+ times per run
 * (more with retries/fan-out) for byte-identical payloads. The cache key
 * is a SHA-1 of the raw payload's JSON — NOT the runId — so a DLQ replay
 * that re-enqueues a PATCHED workflow under the same run can never hit a
 * stale entry: different bytes, different key. `JSON.stringify` + SHA-1
 * is far cheaper than a full schema parse for large workflows.
 *
 * Used by: `packages/engine/src/worker.ts` `validateJobData`.
 *
 * Invariants:
 * - The returned workflow object is SHARED across jobs — treat it as
 *   read-only (the runtime only iterates nodes/edges; nothing mutates
 *   the workflow shape today; keep it that way).
 * - Bounded LRU (`MAX_ENTRIES`) — worst case memory is a handful of
 *   parsed workflow objects, evicted oldest-first.
 */

import { createHash } from "node:crypto";

import { WorkflowSchema, type Workflow } from "@janusly/shared";

/** LRU capacity. Sized for "workflows concurrently executing on one worker", not history. */
const MAX_ENTRIES = 32;

/** Insertion-ordered Map doubles as the LRU: re-insert on hit, evict the oldest key over capacity. */
const cache = new Map<string, Workflow>();

/** Result envelope mirroring `safeParse` so the caller keeps its error path. */
export type CachedWorkflowParse =
  | { ok: true; workflow: Workflow }
  | { ok: false; error: string };

/**
 * Parse `raw` as a Workflow, reusing a prior parse when the exact same
 * JSON bytes were seen recently. Falls back to a plain uncached parse when
 * the payload can't be stringified (circular refs can't come out of a
 * BullMQ job, but stay total anyway).
 */
export function parseWorkflowCached(raw: unknown): CachedWorkflowParse {
  let key: string | null = null;
  try {
    const json = JSON.stringify(raw);
    if (typeof json === "string") {
      key = createHash("sha1").update(json).digest("hex");
    }
  } catch {
    key = null;
  }

  if (key) {
    const hit = cache.get(key);
    if (hit) {
      // Refresh recency so hot workflows survive eviction.
      cache.delete(key);
      cache.set(key, hit);
      return { ok: true, workflow: hit };
    }
  }

  const parsed = WorkflowSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join(", ") };
  }

  if (key) {
    cache.set(key, parsed.data);
    if (cache.size > MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }
  return { ok: true, workflow: parsed.data };
}

/** Test seam — empties the LRU so cases don't leak hits into each other. */
export function clearWorkflowParseCache(): void {
  cache.clear();
}

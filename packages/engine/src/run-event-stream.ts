/**
 * Process-global DI seam for fanning run lifecycle signals out to live
 * subscribers (the SSE stream surface). The engine persists run events to
 * Postgres; this seam lets a host process ALSO push each signal onto a
 * transport (Redis pub/sub) so the API can stream it to connected clients in
 * real time instead of every client polling the database.
 *
 * Mirrors the `setEngineRateLimiter` pattern: the actual transport
 * (a Redis PUBLISH) lives in the host processes, which the engine can't
 * import without inverting the dependency graph. The API process and worker
 * both wire a publisher through this seam at boot. Tests register a fake.
 * When unset (focused unit tests), `publishRunEvent` no-ops.
 *
 * Used by:
 * - `packages/engine/src/persistence.ts` — `appendEvent` (every run_events
 *   row) and `updateRunStatusFromNodes` / `cancelRun` (run-level status flips).
 * - `apps/api/src/index.ts` + `packages/engine/src/worker.ts` — boot path
 *   registers a Redis PUBLISH implementation.
 *
 * Invariants:
 * - `publishRunEvent` NEVER throws. Streaming is best-effort telemetry; a
 *   publisher fault must not break the persistence write that precedes it.
 *   The seam swallows + warn-logs, identical posture to the rate limiter.
 * - The payload handed in is ALREADY redacted (the same object
 *   `safePersistPayload` produced for the persisted row). No secret can reach
 *   a subscriber that wasn't already safe to persist.
 */

/**
 * A run lifecycle signal fanned to live subscribers. Two shapes share the
 * channel:
 * - an `event` mirrors a persisted `run_events` row (`id` is the row's UUID,
 *   used as the SSE `id:` for `Last-Event-ID` reconnect cursors).
 * - a `run.status` is an ephemeral signal emitted at a run-level status flip
 *   (`succeeded` / `failed` / `cancelled` / `timed_out`). These don't persist
 *   as `run_events` rows, so they carry no `id` and are not replayed on
 *   reconnect — they exist only to drive the stream's terminal-close timer.
 */
export type PublishedRunEvent =
  | {
      kind: "event";
      /** The persisted `run_events.id` (UUID) — the SSE `Last-Event-ID` cursor. */
      id: string;
      nodeId: string | null;
      type: string;
      /** Already passed through `safePersistPayload` by the caller. */
      payload: unknown;
      /** ISO-8601 string; the persisted `run_events.createdAt`. */
      createdAt: string;
    }
  | {
      kind: "run.status";
      /** Current run status. Terminal values also drive the stream close timer. */
      status: string;
      /** Optional business-outcome projection carried with the same snapshot. */
      outcomeStatus?: string | null;
      semanticViolationCount?: number;
    };

/** Transport function: push one signal for `runId`. Must not throw. */
export type RunEventPublisher = (runId: string, event: PublishedRunEvent) => void;

/** The wire shape published on the channel: org scope + the signal. */
export type RunEventChannelMessage = { orgId: string; event: PublishedRunEvent };

const CHANNEL_PREFIX = "janusly:run-events:";

/** Redis pub/sub channel for a run's live signals. Shared by publisher + subscriber. */
export function runEventChannel(runId: string): string {
  return `${CHANNEL_PREFIX}${runId}`;
}

/** Recover the `runId` from a channel name; `null` when the prefix doesn't match. */
export function runIdFromRunEventChannel(channel: string): string | null {
  return channel.startsWith(CHANNEL_PREFIX) ? channel.slice(CHANNEL_PREFIX.length) : null;
}

/**
 * Build a `RunEventPublisher` that PUBLISHes each signal to Redis, scoped to
 * the run's org. Centralizing the channel name + message shape + immutable
 * `runId→orgId` cache here keeps the API and worker publishers from drifting
 * apart from the API subscriber. `resolveOrgId` is injected (rather than
 * imported) so this module stays free of a `persistence.ts` import cycle.
 *
 * - `publish` does the actual Redis PUBLISH (`(channel, message) => …`).
 * - `resolveOrgId` maps a runId to its immutable org, or `null` when unknown.
 *
 * The returned publisher is fire-and-forget and never throws.
 */
export function createRedisRunEventPublisher(deps: {
  publish: (channel: string, message: string) => unknown | Promise<unknown>;
  resolveOrgId: (runId: string) => Promise<string | null>;
}): RunEventPublisher {
  // Bound the immutable runId→orgId cache so a long-lived process doesn't
  // accumulate one entry per run forever. The cache is a pure optimization —
  // clearing it just forces a re-resolve, never incorrectness.
  const ORG_ID_CACHE_MAX = 10_000;
  const orgIdCache = new Map<string, string>();
  const inflight = new Map<string, Promise<string | null>>();

  const resolveCached = async (runId: string): Promise<string | null> => {
    const cached = orgIdCache.get(runId);
    if (cached) return cached;
    let pending = inflight.get(runId);
    if (!pending) {
      pending = deps
        .resolveOrgId(runId)
        .finally(() => inflight.delete(runId));
      inflight.set(runId, pending);
    }
    const orgId = await pending;
    if (orgId) {
      if (orgIdCache.size >= ORG_ID_CACHE_MAX) orgIdCache.clear();
      orgIdCache.set(runId, orgId);
    }
    return orgId;
  };

  return (runId, event) => {
    void (async () => {
      try {
        const orgId = await resolveCached(runId);
        if (!orgId) return; // unknown / uncommitted run — nothing to scope to
        const message: RunEventChannelMessage = { orgId, event };
        await deps.publish(runEventChannel(runId), JSON.stringify(message));
      } catch (err) {
        console.warn("[run-stream] publish failed", { runId, err });
      }
    })();
  };
}

let publisher: RunEventPublisher | null = null;

/** Register the process-global publisher. Pass `null` to disable. */
export function setRunEventPublisher(fn: RunEventPublisher | null): void {
  publisher = fn;
}

/** Inspect the currently registered publisher. Returns `null` when unset. */
export function getRunEventPublisher(): RunEventPublisher | null {
  return publisher;
}

/**
 * Fan one signal to the registered publisher. No-ops when unset. Never
 * throws — a publisher fault is swallowed + warn-logged so the preceding
 * persistence write is unaffected.
 */
export function publishRunEvent(runId: string, event: PublishedRunEvent): void {
  if (!publisher) return;
  try {
    publisher(runId, event);
  } catch (err) {
    console.warn("[run-stream] publisher failed", { runId, err });
  }
}

/** Reset the registry. Tests that mutate it between cases call this. */
export function _resetRunEventPublisherForTests(): void {
  publisher = null;
}

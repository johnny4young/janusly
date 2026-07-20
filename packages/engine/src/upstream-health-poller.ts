/**
 * Background poller for upstream status feeds (`upstream_health_sources`).
 *
 * A single `system:`-prefixed BullMQ recurring job (mirror of
 * `memory-retention-scheduler.ts`) sweeps every ENABLED source across all orgs
 * on a fixed tick. Per source it checks whether `checkIntervalSeconds` has
 * elapsed since the last poll, and if so fetches the feed through the
 * `fetchHttpTarget` SSRF chokepoint (DNS-pin / body-cap / timeout / redirect
 * guards apply), parses the body via the PURE `parseUpstreamFeed` helper, and
 * acts on the derived status:
 *
 *   - DEGRADED  → pause every workflow tagged with the source's `name`
 *                 (`workflows.status = paused_upstream_degraded`), audit
 *                 `workflow.paused.upstream` once per actual flip.
 *   - RECOVERED → resume every workflow this source had paused, audit
 *                 `workflow.resumed.upstream` once per actual flip.
 *
 * FAIL-OPEN is the load-bearing safety property: a feed that is unreachable,
 * times out, returns non-JSON, or is missing the watched component does NOT
 * pause anything. An unreachable status page must never amplify an outage by
 * pausing every tagged workflow. The fail-open poll records `lastErrorReason`
 * for operator visibility but leaves the derived status (and therefore the
 * pause state) UNCHANGED.
 *
 * Lives in the engine (worker process) — the worker is the natural home for a
 * cron-style background sweep, mirroring the retention schedulers.
 *
 * Used by:
 *  - `packages/engine/src/worker.ts` — `registerUpstreamHealthScheduler` at
 *    boot + `handleUpstreamHealthTrigger` dispatched on the job name.
 *  - `apps/api/src/routes/upstream-health-routes.ts` — the admin "Check now"
 *    route calls `pollOneSource` directly for an immediate poll.
 *
 * Invariants:
 *  - The handler NEVER throws — a Postgres / Redis blip is caught + logged; the
 *    next tick is the natural retry. BullMQ retries would otherwise amplify the
 *    noise.
 *  - The registrar NEVER throws — a `upsertJobScheduler` failure is logged and
 *    reported false; the boot path continues.
 *  - Multi-tenant: the sweep is cross-org by design, but every pause/resume is
 *    scoped to the source's own `orgId` (passed into the repo helpers). No
 *    cross-tenant pause is possible.
 */

import {
  recordSystemAudit,
  WORKFLOW_STATUS_PAUSED_UPSTREAM,
  listSourcesToPoll,
  listWorkflowIdsTaggedWithSource,
  pauseWorkflowsForUpstream,
  recordUpstreamPollError,
  recordUpstreamStatus,
  resumeWorkflowsForUpstream,
  type UpstreamHealthSource,
} from "@janusly/data";
import { parseUpstreamFeed, type UpstreamFeedParseResult } from "@janusly/shared";

import { fetchHttpTarget, type HttpBufferedResult } from "./http-policy";
import { workflowQueue } from "./queue";
import { validateCronExpression } from "./schedule";

/** Deterministic global scheduler id. The `system:` prefix is reserved for non-tenant cron jobs. */
export const UPSTREAM_HEALTH_JOB_ID = "system:upstream-health-poll";

/** The `job.name` the worker dispatch matches on. */
export const UPSTREAM_HEALTH_JOB_NAME = "upstream-health-poll-trigger";

/**
 * Default tick cadence. Every minute — the per-source `checkIntervalSeconds`
 * (min 30s) gates whether a given source actually polls on a tick, so the tick
 * just needs to be at-or-below the smallest interval.
 */
export const DEFAULT_UPSTREAM_HEALTH_CRON = "* * * * *";

/** Bound on the response body we buffer from a status page (256 KiB is plenty for Statuspage JSON). */
const UPSTREAM_FEED_MAX_BYTES = 256 * 1024;
/** Per-source fetch timeout. A slow status page must not stall the sweep. */
const UPSTREAM_FEED_TIMEOUT_MS = 10_000;
/** Audit metadata size bound (matches the API chokepoint default). */

/** Injectable fetcher so tests can drive the parse/pause logic without the network. */
export type UpstreamFetcher = (
  url: string,
) => Promise<Pick<HttpBufferedResult, "statusCode" | "ok" | "body">>;

const defaultFetcher: UpstreamFetcher = async (url) => {
  const res = await fetchHttpTarget(url, {
    method: "GET",
    timeoutMs: UPSTREAM_FEED_TIMEOUT_MS,
    maxResponseBytes: UPSTREAM_FEED_MAX_BYTES,
  });
  return { statusCode: res.statusCode, ok: res.ok, body: res.body };
};

// ─── audit ────────────────────────────────────────────────────────────────────

/** System-actor audit via the shared data-layer chokepoint. */
function writeAuditRow(input: {
  orgId: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  return recordSystemAudit({
    ...input,
    actor: "system:upstream-health",
    logTag: "[upstream-health]",
  });
}

// ─── single-source poll (testable core) ────────────────────────────────────────

export type PollOneSourceResult = {
  /** The derived parse outcome (fail-open results have `ok: false`). */
  parse: UpstreamFeedParseResult;
  /** Workflow ids that flipped to paused this poll. */
  pausedWorkflowIds: string[];
  /** Workflow ids that flipped back to active this poll. */
  resumedWorkflowIds: string[];
  /** True when the feed was unreachable / unparseable (fail-open — nothing paused). */
  failedOpen: boolean;
};

/**
 * Poll a single source: fetch → parse → record status → pause/resume tagged
 * workflows. Pure of the scheduler; the API "Check now" route and the sweep
 * both call it. NEVER throws — a fetch error becomes a fail-open result.
 *
 * Fetch errors (network, timeout, body-cap abort) and unparseable / missing
 * component results are ALL fail-open: `lastStatus` / `lastDegraded` stay
 * unchanged and NO workflow is paused. Only a successful parse with
 * `degraded: true` pauses; a successful parse with `degraded: false` resumes.
 */
export async function pollOneSource(
  source: UpstreamHealthSource,
  fetcher: UpstreamFetcher = defaultFetcher,
): Promise<PollOneSourceResult> {
  let parse: UpstreamFeedParseResult;
  try {
    const res = await fetcher(source.url);
    if (source.kind === "http_probe") {
      parse = parseUpstreamFeed({
        kind: source.kind,
        expectedComponents: source.expectedComponents,
        statusCode: res.statusCode,
      });
    } else {
      let json: unknown;
      try {
        json = JSON.parse(res.body);
      } catch {
        json = undefined; // parser returns { ok: false, reason: "unparseable" }
      }
      parse = parseUpstreamFeed({
        kind: source.kind,
        expectedComponents: source.expectedComponents,
        json,
      });
    }
  } catch (err) {
    // FAIL-OPEN: unreachable / timed-out feed. Record the reason, pause nothing.
    await recordUpstreamPollError({
      orgId: source.orgId,
      id: source.id,
      reason: "unreachable",
    });
    console.warn("[upstream-health] feed fetch failed (fail-open)", {
      sourceId: source.id,
      name: source.name,
      err: err instanceof Error ? err.message : String(err),
    });
    return { parse: { ok: false, reason: "unparseable" }, pausedWorkflowIds: [], resumedWorkflowIds: [], failedOpen: true };
  }

  if (!parse.ok) {
    // FAIL-OPEN: unparseable body / missing component / no status. Record the
    // reason for operator visibility; do NOT pause.
    await recordUpstreamPollError({ orgId: source.orgId, id: source.id, reason: parse.reason });
    return { parse, pausedWorkflowIds: [], resumedWorkflowIds: [], failedOpen: true };
  }

  // Successful parse — persist the derived status.
  await recordUpstreamStatus({
    orgId: source.orgId,
    id: source.id,
    status: parse.status,
    degraded: parse.degraded,
  });

  const taggedWorkflowIds = await listWorkflowIdsTaggedWithSource(source.orgId, source.name);
  if (taggedWorkflowIds.length === 0) {
    return { parse, pausedWorkflowIds: [], resumedWorkflowIds: [], failedOpen: false };
  }

  if (parse.degraded) {
    const reason = `Upstream "${source.name}" degraded (${parse.status})`;
    const pausedWorkflowIds = await pauseWorkflowsForUpstream({
      orgId: source.orgId,
      workflowIds: taggedWorkflowIds,
      reason,
    });
    for (const workflowId of pausedWorkflowIds) {
      await writeAuditRow({
        orgId: source.orgId,
        action: "workflow.paused.upstream",
        targetType: "workflow",
        targetId: workflowId,
        metadata: {
          sourceName: source.name,
          sourceKind: source.kind,
          status: parse.status,
          components: parse.components,
        },
      });
    }
    return { parse, pausedWorkflowIds, resumedWorkflowIds: [], failedOpen: false };
  }

  // Recovered (degraded: false). Resume only the workflows this source paused.
  const resumedWorkflowIds = await resumeWorkflowsForUpstream({
    orgId: source.orgId,
    workflowIds: taggedWorkflowIds,
  });
  for (const workflowId of resumedWorkflowIds) {
    await writeAuditRow({
      orgId: source.orgId,
      action: "workflow.resumed.upstream",
      targetType: "workflow",
      targetId: workflowId,
      metadata: { sourceName: source.name, sourceKind: source.kind, status: parse.status },
    });
  }
  return { parse, pausedWorkflowIds: [], resumedWorkflowIds, failedOpen: false };
}

/**
 * Decide whether a source is due for a poll based on `checkIntervalSeconds`
 * elapsed since `lastCheckedAt`. A never-polled source (`lastCheckedAt == null`)
 * is always due. Pure — testable without a clock dependency.
 */
export function isSourceDue(source: UpstreamHealthSource, now: number = Date.now()): boolean {
  if (!source.lastCheckedAt) return true;
  const elapsedMs = now - source.lastCheckedAt.getTime();
  return elapsedMs >= source.checkIntervalSeconds * 1000;
}

// ─── scheduler ──────────────────────────────────────────────────────────────

function resolveCronPattern(env: NodeJS.ProcessEnv): string {
  const raw = env.JANUSLY_UPSTREAM_HEALTH_CRON?.trim();
  if (!raw) return DEFAULT_UPSTREAM_HEALTH_CRON;
  try {
    validateCronExpression(raw);
    return raw;
  } catch (err) {
    console.warn(
      "[upstream-health] JANUSLY_UPSTREAM_HEALTH_CRON invalid; falling back to default",
      { value: raw, error: err instanceof Error ? err.message : String(err) },
    );
    return DEFAULT_UPSTREAM_HEALTH_CRON;
  }
}

/** Register the recurring poll sweep. Idempotent via the deterministic id. NEVER throws semantics via the caller's try/catch. */
export async function registerUpstreamHealthScheduler(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const pattern = resolveCronPattern(env);
  try {
    await workflowQueue.upsertJobScheduler(
      UPSTREAM_HEALTH_JOB_ID,
      { pattern },
      { name: UPSTREAM_HEALTH_JOB_NAME, data: {} },
    );
    return true;
  } catch (err) {
    console.error("[upstream-health] upsertJobScheduler failed", { jobId: UPSTREAM_HEALTH_JOB_ID, err });
    return false;
  }
}

/**
 * BullMQ handler. Sweeps every enabled source and polls the ones that are due.
 * NEVER throws — per-source failures are caught so one bad source can't stall
 * the rest of the sweep.
 */
export async function handleUpstreamHealthTrigger(
  fetcher: UpstreamFetcher = defaultFetcher,
): Promise<void> {
  let sources: UpstreamHealthSource[];
  try {
    sources = await listSourcesToPoll();
  } catch (err) {
    console.error("[upstream-health] failed to list sources", { err });
    return;
  }

  const now = Date.now();
  for (const source of sources) {
    if (!isSourceDue(source, now)) continue;
    try {
      await pollOneSource(source, fetcher);
    } catch (err) {
      // pollOneSource is defensive, but a Postgres blip in a repo write could
      // still bubble — never let it stall the sweep.
      console.error("[upstream-health] pollOneSource threw — should never happen", {
        sourceId: source.id,
        name: source.name,
        err,
      });
    }
  }
}

// Re-export the paused status constant so the worker dispatch + tests can
// reference it without a second import line.
export { WORKFLOW_STATUS_PAUSED_UPSTREAM };

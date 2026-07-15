/**
 * Run lifecycle + read surfaces.
 *
 * Route ordering inside this module matters: `/runs` is a prefix
 * matcher that excludes `/run?` so the next entry can claim the
 * single-run read.
 *
 * Production-mode `/start` gate: when `JANUSLY_PRODUCTION_MODE=true`,
 * the deterministic readiness check + rollback-availability sidecar
 * runs before `startRun` and rejects fail-level issues with HTTP 422.
 * Dev mode keeps the existing behaviour — anything structurally valid
 * runs.
 */

import { and, asc, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";

import {
  getOrgConfigSnapshot,
  getRunComparison,
  queryRunUsage,
  getWorkflowStatus,
  WORKFLOW_STATUS_ACTIVE,
} from "@janusly/data";
import { db, runEvents, runNodes, runs, workflows, workflowVersions } from "@janusly/db";
import { replayDecision } from "@janusly/domain";
import { replayRunAsValidation, replayRunAsValidationFork } from "@janusly/engine/src/adapters/replay-lab";
import { WorkflowInputValidationError } from "@janusly/engine/src/inputs-validator";
import { cancelRun } from "@janusly/engine/src/persistence";
import type { PublishedRunEvent } from "@janusly/engine/src/run-event-stream";
import { ResumeRunConflictError, resumeRun } from "@janusly/engine/src/resume-run";
import { startRun } from "@janusly/engine/src/start-run";
import { checkWorkflowReadiness } from "@janusly/engine/src/workflow-readiness";
import { validateWorkflow } from "@janusly/engine/src/workflow-validation";
import { WorkflowSchema, type Workflow } from "@janusly/shared";
import { isTerminalRunStatus, runStatusValues } from "@janusly/shared/src/status";

import { decisionCandidatesFromPayload, orgLlmRuntime, sanitizeAiWorkflow } from "../ai-runtime";
import { auditAction } from "../audit-helper";
import { MAX_JSON_BODY_BYTES, RUN_EVENTS_DEFAULT_LIMIT, RUN_EVENTS_MAX_LIMIT } from "../api-config";
import { RATE_LIMIT_WINDOW_MS } from "../constants";
import { asRecord, corsHeaders, readJson, sendEventFrame, sendError, sendJson, sendSseComment } from "../http";
import { guardMcpWrite } from "../mcp-consent";
import { paginateRunEvents, parseEventsCursor, parseEventsLimit, parseKeysetCursor } from "../run-pagination";
import { enforceRateLimit } from "../rate-limit";
import { getRunStreamHub } from "../run-stream";
import {
  checkRollbackAvailability,
  getCredentialReadinessIssues,
  mergeReadiness,
  productionSecretRefResolver,
} from "../readiness-helpers";
import type { Route } from "../routes";
import { getRunContract, getRunStatusContract, getRunUsageContract, listRunsContract } from "../api-contracts";

// SSE heartbeat cadence. The server destroys idle sockets after 60s
// (`server.setTimeout`); a comment well under that keeps an idle run's
// stream alive without a flood of frames.
const STREAM_HEARTBEAT_MS = 25_000;
// After a run reaches a terminal status, hold the stream open briefly so
// trailing node events flush, then close server-side.
const STREAM_TERMINAL_GRACE_MS = 30_000;
// Client reconnect backoff hint (SSE `retry:` field), in ms.
const STREAM_RETRY_HINT_MS = 3_000;
// Cap the per-connect Last-Event-ID catch-up replay so a long-disconnected
// client can't pull an unbounded backlog in one shot.
const STREAM_CATCHUP_MAX = 500;
// Bound publications waiting behind catch-up or socket backpressure. Persisted
// events remain recoverable through Last-Event-ID, so closing and reconnecting
// is safer than allowing one slow client to consume unbounded process memory.
const STREAM_LIVE_QUEUE_MAX_BYTES = 1_048_576;

function publishedRunEventBytes(event: PublishedRunEvent): number {
  try {
    return Buffer.byteLength(JSON.stringify(event), "utf8") + 128;
  } catch {
    return STREAM_LIVE_QUEUE_MAX_BYTES + 1;
  }
}

// Summary projection for the `/runs` LIST surfaces. Deliberately excludes
// `inputJson`: it carries the full workflow snapshot captured by `startRun`,
// so a 100-row page would ship 100 workflow JSONs the list never renders.
// The `GET /run?runId=` detail read keeps the full row.
const runListColumns = {
  id: runs.id,
  orgId: runs.orgId,
  // Run rows created from the live authoring surface carry the workflow id
  // directly, while scheduled/triggered runs carry an immutable version id.
  // Resolve both into one stable list field without exposing the full version.
  workflowId: sql<string>`coalesce(${workflowVersions.workflowId}, ${runs.workflowVersionId})`,
  // Project only the captured display name from input_json. The list still
  // avoids returning the workflow snapshot and trigger payload.
  workflowName: sql<string | null>`${runs.inputJson}->'workflow'->>'name'`,
  workflowVersionId: runs.workflowVersionId,
  status: runs.status,
  outputJson: runs.outputJson,
  parentRunId: runs.parentRunId,
  parentNodeId: runs.parentNodeId,
  traceId: runs.traceId,
  replayMode: runs.replayMode,
  createdBy: runs.createdBy,
  createdAt: runs.createdAt,
};

// Public run-node projection shared by legacy and `/v1` detail reads.
// Recovery claim columns are internal worker CAS state and must never become
// an accidental wire-contract addition through Drizzle's select-all shape.
const runNodePublicColumns = {
  id: runNodes.id,
  runId: runNodes.runId,
  nodeId: runNodes.nodeId,
  status: runNodes.status,
  stateJson: runNodes.stateJson,
  attempts: runNodes.attempts,
  startedAt: runNodes.startedAt,
  finishedAt: runNodes.finishedAt,
  errorJson: runNodes.errorJson,
};

export const runsRoutes: Route[] = [
  // Live run stream (SSE over Redis pub/sub). MUST precede the `/runs` list
  // matcher below — both are GET and `/runs/<id>/stream` starts with `/runs`,
  // so first-match-wins requires this entry first. Events are fanned from the
  // engine's run-event seam through Redis; the per-run channel + the
  // `run.orgId === auth.orgId` gate + the hub's per-publish org re-check are
  // the tenant boundary. Initial timeline history comes from the regular
  // `/run` fetch; this stream carries live signals plus a bounded overlap/gap
  // replay from the newest `Last-Event-ID` (or the beginning when the timeline
  // was empty at connect time).
  { method: "GET", match: (url) => /^\/runs\/[^/?]+\/stream(\?|$)/.test(url), permission: "runs.read",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const runId = decodeURIComponent(url.pathname.split("/")[2] ?? "");
      if (!runId) return sendError(res, "runs_run_id_required", "runId is required", 400);

      const run = await db
        .select({ status: runs.status })
        .from(runs)
        .where(and(eq(runs.id, runId), eq(runs.orgId, auth.orgId)));
      if (!run[0]) return sendError(res, "runs_forbidden", "Forbidden", 403);

      const { runs: runConfig } = await getOrgConfigSnapshot(auth.orgId);

      let torn = false;
      let graceTimer: ReturnType<typeof setTimeout> | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let heartbeatWaitingForDrain = false;
      let removeSubscriber: (() => void) | null = null;
      const teardown = (endResponse: boolean) => {
        if (torn) return;
        torn = true;
        if (heartbeat) clearInterval(heartbeat);
        if (graceTimer) clearTimeout(graceTimer);
        removeSubscriber?.();
        if (endResponse && !res.writableEnded) res.end();
      };
      function armGraceClose() {
        if (graceTimer || torn) return;
        graceTimer = setTimeout(() => teardown(true), STREAM_TERMINAL_GRACE_MS);
        graceTimer.unref?.();
      }

      const waitForDrain = async () => {
        if (torn || res.writableEnded) return;
        await new Promise<void>((resolve) => {
          const done = () => {
            res.off("drain", done);
            res.off("close", done);
            res.off("finish", done);
            req.off("close", done);
            resolve();
          };
          res.once("drain", done);
          res.once("close", done);
          res.once("finish", done);
          req.once("close", done);
        });
      };
      const writeSseFrame = async (frame: { id?: string; event?: string; data: unknown }) => {
        if (torn || res.writableEnded) return;
        if (!sendEventFrame(res, frame)) await waitForDrain();
      };
      const writeFrame = async (event: PublishedRunEvent) => {
        if (event.kind === "event") {
          await writeSseFrame({ id: `${event.createdAt}|${event.id}`, event: "run-event", data: event });
          return;
        }
        await writeSseFrame({ event: "run-status", data: event });
        if (isTerminalRunStatus(event.status)) armGraceClose();
      };

      // Subscribe before reading the reconnect gap so no publication can land
      // between the database snapshot and the live channel. Live frames are
      // buffered until catch-up finishes; otherwise a newly-published event
      // could advance the browser's Last-Event-ID beyond an older missing page.
      let catchingUp = true;
      const bufferedLiveFrames: Array<{ event: PublishedRunEvent; bytes: number }> = [];
      let pendingLiveBytes = 0;
      let deliveryTail = Promise.resolve();
      const writeLiveFrame = (event: PublishedRunEvent) => {
        const bytes = publishedRunEventBytes(event);
        if (pendingLiveBytes + bytes > STREAM_LIVE_QUEUE_MAX_BYTES) {
          teardown(true);
          return;
        }
        pendingLiveBytes += bytes;
        if (catchingUp) {
          bufferedLiveFrames.push({ event, bytes });
          return;
        }
        deliveryTail = deliveryTail
          .then(() => writeFrame(event))
          .catch(() => teardown(true))
          .finally(() => { pendingLiveBytes -= bytes; });
      };

      const hub = getRunStreamHub();
      const added = hub.addSubscriber(
        runId,
        auth.orgId,
        writeLiveFrame,
        runConfig.streamMaxSubscriptions,
        () => teardown(res.headersSent),
      );
      if (!added.ok) {
        return sendError(res, "stream_cap_exceeded", "Too many live run streams for this organization", 429);
      }
      removeSubscriber = added.remove;

      try {
        // SUBSCRIBE acknowledgment is the ordering barrier: only after it
        // resolves can the database catch-up snapshot safely overlap with the
        // live publication buffer.
        await added.ready;
      } catch {
        teardown(false);
        if (!res.headersSent && !res.writableEnded) {
          return sendError(res, "stream_unavailable", "Live run stream is unavailable", 503);
        }
        return;
      }
      if (torn) return;

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        // Disable proxy buffering (nginx) so frames flush immediately.
        "X-Accel-Buffering": "no",
        ...corsHeaders(res),
      });
      req.on("close", () => teardown(false));

      try {
        if (!res.write(`retry: ${STREAM_RETRY_HINT_MS}\n\n`)) await waitForDrain();
        if (!sendSseComment(res, "connected")) await waitForDrain();

        heartbeat = setInterval(() => {
          if (torn || res.writableEnded) return;
          try {
            if (!heartbeatWaitingForDrain && !sendSseComment(res, "keep-alive")) {
              heartbeatWaitingForDrain = true;
              void waitForDrain()
                .catch(() => teardown(true))
                .finally(() => { heartbeatWaitingForDrain = false; });
            }
          } catch {
            teardown(true);
          }
        }, STREAM_HEARTBEAT_MS);

        // Replay from the client's composite cursor. With no Last-Event-ID we
        // replay from the beginning: this closes the initial-empty-timeline
        // race between the regular `/run` fetch and Redis subscription. Web
        // state dedupes the intentional overlap by event id.
        const rawLastId = req.headers["last-event-id"];
        const lastEventId = Array.isArray(rawLastId) ? rawLastId[0] : rawLastId;
        const cursor = parseEventsCursor(lastEventId ?? null);
        const eventBoundary = cursor
          ? or(
              gt(runEvents.createdAt, cursor.createdAt),
              and(eq(runEvents.createdAt, cursor.createdAt), gt(runEvents.id, cursor.id)),
            )
          : undefined;
        const rows = await db
          .select()
          .from(runEvents)
          .where(eventBoundary
            ? and(eq(runEvents.runId, runId), eventBoundary)
            : eq(runEvents.runId, runId))
          .orderBy(asc(runEvents.createdAt), asc(runEvents.id))
          // Read one sentinel row beyond the wire cap so the protocol can
          // report that another bounded reconnect page is required.
          .limit(STREAM_CATCHUP_MAX + 1);
        if (torn) return;

        const replayRows = rows.slice(0, STREAM_CATCHUP_MAX);
        for (const row of replayRows) {
          await writeFrame({
            kind: "event",
            id: row.id,
            nodeId: row.nodeId,
            type: row.type,
            payload: row.payload,
            createdAt: (row.createdAt ?? new Date()).toISOString(),
          });
          if (torn) return;
        }
        if (rows.length > STREAM_CATCHUP_MAX) {
          await writeSseFrame({
            event: "catchup-truncated",
            data: { kind: "catchup-truncated", replayed: replayRows.length },
          });
          // Do not flush live frames after a truncated page: the browser must
          // reconnect from the last replayed cursor before it can safely join
          // the live tail.
          teardown(true);
          return;
        }

        // The pre-subscription run row may be stale after catch-up. Re-read the
        // tenant-scoped status, then fold statuses buffered during that query
        // into the snapshot while delivering their event frames first.
        const latestRun = await db
          .select({ status: runs.status })
          .from(runs)
          .where(and(eq(runs.id, runId), eq(runs.orgId, auth.orgId)));
        if (!latestRun[0] || torn) {
          teardown(true);
          return;
        }
        let effectiveStatus = latestRun[0].status;
        while (bufferedLiveFrames.length > 0 && !torn) {
          const buffered = bufferedLiveFrames.shift();
          if (!buffered) break;
          if (buffered.event.kind === "run.status") {
            effectiveStatus = buffered.event.status;
            pendingLiveBytes -= buffered.bytes;
          } else {
            try {
              await writeFrame(buffered.event);
            } finally {
              pendingLiveBytes -= buffered.bytes;
            }
          }
        }
        await writeFrame({ kind: "run.status", status: effectiveStatus });

        // A slow socket can yield while the snapshot is written. Drain any
        // publications that arrived in that interval before switching the hub
        // callback to its serialized steady-state delivery queue.
        while (bufferedLiveFrames.length > 0 && !torn) {
          const buffered = bufferedLiveFrames.shift();
          if (!buffered) break;
          try {
            await writeFrame(buffered.event);
          } finally {
            pendingLiveBytes -= buffered.bytes;
          }
        }
        catchingUp = false;
      } catch {
        // Headers may already be committed. Never bubble into the JSON error
        // dispatcher; close the SSE response and release every stream resource.
        teardown(true);
      }
    } },

  // Resource-backed run diagnostics. This exact read must precede the broad
  // `/runs` list matcher below. The run lookup preserves the legacy
  // non-enumerating forbidden response for missing and cross-tenant ids.
  { method: "GET", match: (url) => url === "/run/usage" || url.startsWith("/run/usage?"), permission: "runs.read",
    contract: getRunUsageContract,
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const runId = url.searchParams.get("runId");
      if (!runId) return sendError(res, "runs_run_id_required", "runId is required", 400);
      const run = await db
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.id, runId), eq(runs.orgId, auth.orgId)))
        .limit(1);
      if (!run[0]) return sendError(res, "runs_forbidden", "Forbidden", 403);
      return sendJson(res, await queryRunUsage(auth.orgId, runId));
    } },

  // Runs — list + reads
  // NOTE: `/runs` prefix excludes `/run?` so the GET `/run?…` entry below
  // can claim it, and excludes `/runs/compare` so the Replay Lab compare
  // route below can claim it (both are first-match-wins).
  // Optional workflow/status filters compose with a stable keyset boundary.
  // The `workflow_versions` join is tenant-scoped: an inconsistent cross-org
  // version reference cannot resolve another tenant's workflow identity.
  { method: "GET", match: (url) => url.startsWith("/runs") && !url.startsWith("/run?") && !url.startsWith("/runs/compare"),
    contract: listRunsContract,
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const limitParam = Number(url.searchParams.get("limit"));
      const limitValue = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 100;
      const workflowIdFilter = url.searchParams.get("workflowId");
      const statusParam = url.searchParams.get("status");
      const runKindParam = url.searchParams.get("runKind");
      if (statusParam && !runStatusValues.some((status) => status === statusParam)) {
        return sendError(res, "invalid_input", "status must be a valid run status", 400);
      }
      if (runKindParam && runKindParam !== "production" && runKindParam !== "validation") {
        return sendError(res, "invalid_input", "runKind must be production or validation", 400);
      }
      const before = parseKeysetCursor(url.searchParams.get("before"));
      const filters = [eq(runs.orgId, auth.orgId)];
      if (workflowIdFilter) {
        filters.push(or(
          eq(workflowVersions.workflowId, workflowIdFilter),
          and(
            isNull(workflowVersions.id),
            eq(runs.workflowVersionId, workflowIdFilter),
          ),
        )!);
      }
      if (statusParam) filters.push(eq(runs.status, statusParam));
      if (runKindParam === "production") filters.push(isNull(runs.replayMode));
      if (runKindParam === "validation") filters.push(eq(runs.replayMode, "validation"));
      if (before) {
        filters.push(or(
          lt(runs.createdAt, before.createdAt),
          and(eq(runs.createdAt, before.createdAt), lt(runs.id, before.id)),
        )!);
      }

      const rows = await db
        .select(runListColumns)
        .from(runs)
        .leftJoin(workflowVersions, and(
          eq(workflowVersions.id, runs.workflowVersionId),
          eq(workflowVersions.orgId, auth.orgId),
        ))
        .where(and(...filters))
        .orderBy(desc(runs.createdAt), desc(runs.id))
        .limit(limitValue);
      return sendJson(res, rows);
    } },
  { method: "GET", match: (url) => url.startsWith("/run?"),
    contract: getRunContract,
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const runId = url.searchParams.get("runId");
      if (!runId) return sendError(res, "runs_run_id_required", "runId is required", 400);
      const run = await db.select().from(runs).where(eq(runs.id, runId));
      if (!run[0] || run[0].orgId !== auth.orgId) return sendError(res, "runs_forbidden", "Forbidden", 403);
      const nodes = await db.select(runNodePublicColumns).from(runNodes).where(eq(runNodes.runId, runId)).orderBy(asc(runNodes.startedAt), asc(runNodes.nodeId));
      const limit = parseEventsLimit(url.searchParams.get("eventsLimit"), RUN_EVENTS_DEFAULT_LIMIT, RUN_EVENTS_MAX_LIMIT);
      const cursor = parseEventsCursor(url.searchParams.get("eventsCursor"));
      // Composite (createdAt, id) keyset cursor: events sharing exact createdAt
      // (e.g. inserts within one transaction) tie-break on id so pagination
      // always advances and never skips peers.
      const filter = cursor
        ? and(
            eq(runEvents.runId, runId),
            or(
              lt(runEvents.createdAt, cursor.createdAt),
              and(eq(runEvents.createdAt, cursor.createdAt), lt(runEvents.id, cursor.id)),
            ),
          )
        : eq(runEvents.runId, runId);
      const rows = await db
        .select()
        .from(runEvents)
        .where(filter)
        .orderBy(desc(runEvents.createdAt), desc(runEvents.id))
        .limit(limit + 1);
      const page = paginateRunEvents(rows, limit);
      return sendJson(res, { run: run[0], nodes, ...page });
    } },
  // Poll-oriented read: `/status` always returns the latest event page.
  // Historical pages use `/run?eventsCursor=...` so polling cannot get
  // stuck walking older history while the run is still changing.
  { method: "GET", match: (url) => url.startsWith("/status"),
    contract: getRunStatusContract,
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const runId = url.searchParams.get("runId");
      if (!runId) return sendError(res, "runs_run_id_required", "runId is required", 400);
      const run = await db.select().from(runs).where(eq(runs.id, runId));
      if (!run[0] || run[0].orgId !== auth.orgId) return sendError(res, "runs_forbidden", "Forbidden", 403);
      const nodes = await db.select(runNodePublicColumns).from(runNodes).where(eq(runNodes.runId, runId)).orderBy(asc(runNodes.startedAt), asc(runNodes.nodeId));
      const limit = parseEventsLimit(url.searchParams.get("eventsLimit"), RUN_EVENTS_DEFAULT_LIMIT, RUN_EVENTS_MAX_LIMIT);
      const rows = await db
        .select()
        .from(runEvents)
        .where(eq(runEvents.runId, runId))
        .orderBy(desc(runEvents.createdAt), desc(runEvents.id))
        .limit(limit + 1);
      const page = paginateRunEvents(rows, limit);
      return sendJson(res, { run: run[0], nodes, ...page });
    } },
  // Run lifecycle (start / resume / cancel)
  { method: "POST", match: "/start", role: "editor",
    handler: async ({ req, res, auth }) => {
      const startMcpGate = await guardMcpWrite(auth, "runs.start");
      if (!startMcpGate.ok) return sendJson(res, startMcpGate.body, startMcpGate.status);
      // Body shape: either a flat workflow (legacy) or `{ workflow, input }`
      // for typed workflow inputs. The flat form keeps existing callers
      // working; the wrapped form is required when the workflow declares
      // `inputs`.
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const workflow = (body.workflow && typeof body.workflow === "object")
        ? asRecord(body.workflow)
        : body;
      const inputValue = Object.hasOwn(body, "input") ? body.input : {};
      // Explicit operator override to start a run even when the workflow is
      // paused by an upstream-health degradation. Surfaced as the "Force run"
      // button on the paused-workflow UI; audited separately so the override
      // is traceable.
      const forceRunDuringPause = body.forceRunDuringPause === true;

      const validation = validateWorkflow(workflow);
      if (!validation.valid) return sendError(res, "runs_validation_failed", "Validation failed", 400);
      const parsedWorkflow = WorkflowSchema.parse(workflow);

      // Production-mode opt-in gate: when `JANUSLY_PRODUCTION_MODE=true`, the
      // deterministic readiness check runs before `startRun` and rejects
      // fail-level issues with HTTP 422. The check is the same one
      // `/workflows/readiness` exposes, layered with the rollback-availability
      // helper. Dev mode (env unset) keeps the existing behaviour — anything
      // structurally valid runs. Operators that need per-workflow opt-in
      // should set the env in their production deploy and leave it unset
      // locally. Adhoc unsaved workflows skip the rollback check (no
      // workflow_versions rows to count).
      if (process.env.JANUSLY_PRODUCTION_MODE === "true") {
        const baseReadiness = checkWorkflowReadiness(parsedWorkflow);
        const [rollbackIssues, credentialIssues] = await Promise.all([
          checkRollbackAvailability(auth.orgId, parsedWorkflow.id),
          getCredentialReadinessIssues(auth.orgId, parsedWorkflow, productionSecretRefResolver),
        ]);
        const readiness = mergeReadiness(baseReadiness, [...rollbackIssues, ...credentialIssues]);
        if (readiness.status === "fail") {
          return sendError(res, "runs_not_production_ready", "Workflow not production-ready", 422);
        }
      }

      // Track whether this run is for a workflow we've persisted (saved) or
      // an ad-hoc one constructed in the request body. Ad-hoc starts are
      // legitimate (AI Studio "Run" before Save) but operators may want to
      // forbid them per tenant via `runs.requireSavedWorkflow`.
      const { runs: runConfig } = await getOrgConfigSnapshot(auth.orgId);
      const requireSaved = runConfig.requireSavedWorkflow;
      let isAdhoc = true;
      if (typeof parsedWorkflow.id === "string" && parsedWorkflow.id) {
        const owned = await db
          .select({ id: workflows.id })
          .from(workflows)
          .where(and(eq(workflows.id, parsedWorkflow.id), eq(workflows.orgId, auth.orgId), isNull(workflows.deletedAt)));
        isAdhoc = owned.length === 0;
      }
      if (requireSaved && isAdhoc) {
        return sendError(res, "runs_adhoc_disabled", "Ad-hoc workflows are disabled. Save the workflow first.", 403);
      }

      // Upstream-health pause gate. A saved workflow auto-paused by a degraded
      // upstream source rejects new run starts with HTTP 409 unless the operator
      // explicitly forces the run. Ad-hoc workflows have no persisted status row
      // so they're never gated here. The pause is set/cleared by the worker's
      // background poller (`upstream-health-poller.ts`).
      let forcedDuringPause = false;
      if (!isAdhoc && typeof parsedWorkflow.id === "string" && parsedWorkflow.id) {
        const wfStatus = await getWorkflowStatus(auth.orgId, parsedWorkflow.id);
        if (wfStatus && wfStatus.status !== WORKFLOW_STATUS_ACTIVE) {
          if (!forceRunDuringPause) {
            return sendError(
              res,
              "upstream_degraded",
              wfStatus.pausedReason ?? "Workflow is paused because an upstream dependency is degraded",
              409,
              { status: wfStatus.status },
            );
          }
          forcedDuringPause = true;
          await auditAction(auth, "workflow.force_run_during_pause", {
            targetType: "workflow",
            targetId: parsedWorkflow.id,
            metadata: { status: wfStatus.status, pausedReason: wfStatus.pausedReason },
          });
        }
      }

      try {
        const result = await startRun({
          ...parsedWorkflow,
          input: inputValue,
          orgId: auth.orgId,
          createdBy: auth.userId,
        });
        await auditAction(auth, isAdhoc ? "run.started.adhoc" : "run.started", { targetType: "run", targetId: result.runId, metadata: {
          workflowId: parsedWorkflow.id,
          adhoc: isAdhoc,
          ...(forcedDuringPause ? { forcedDuringPause: true } : {}),
        } });
        return sendJson(res, result);
      } catch (err) {
        if (err instanceof WorkflowInputValidationError) {
          return sendError(res, "runs_input_validation_failed", "Input validation failed", 400);
        }
        throw err;
      }
    } },
  { method: "POST", match: "/resume", role: "editor",
    handler: async ({ req, res, auth }) => {
      const resumeMcpGate = await guardMcpWrite(auth, "runs.resume");
      if (!resumeMcpGate.ok) return sendJson(res, resumeMcpGate.body, resumeMcpGate.status);
      const { runId, nodeId, input, resumeToken } = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      if (typeof runId !== "string" || typeof nodeId !== "string") return sendError(res, "runs_run_id_and_node_id_required", "runId and nodeId are required", 400);
      const run = await db.select().from(runs).where(eq(runs.id, runId));
      if (!run[0] || run[0].orgId !== auth.orgId) return sendError(res, "runs_forbidden", "Forbidden", 403);
      try {
        const result = await resumeRun(runId, nodeId, {
          input,
          resumeToken: typeof resumeToken === "string" ? resumeToken : undefined,
        });
        await auditAction(auth, "run.resumed", { targetType: "run", targetId: runId, metadata: { nodeId } });
        return sendJson(res, result);
      } catch (err) {
        if (err instanceof WorkflowInputValidationError) {
          return sendError(res, "runs_input_validation_failed", "Input validation failed", 400);
        }
        if (err instanceof ResumeRunConflictError) {
          return sendError(res, "runs_resume_conflict", err.message, 409);
        }
        if (err instanceof Error && err.message === "resumeToken is required") {
          return sendError(res, "runs_resume_token_required", "resumeToken is required", 400);
        }
        if (err instanceof Error && err.message === "Invalid resume token") {
          return sendError(res, "runs_invalid_resume_token", "Invalid resume token", 403);
        }
        throw err;
      }
    } },
  // Cancel an in-flight run. Mirrors `/resume`'s shape; `cancelRun`
  // (engine helper) flips run + non-running nodes to "cancelled" and emits a
  // `run.cancelled` event. The worker's running job continues to completion;
  // the cancelled-stays-cancelled rollup absorbs the post-cancel writes.
  { method: "POST", match: "/run/cancel", role: "editor", permission: "runs.cancel",
    handler: async ({ req, res, auth }) => {
      const cancelMcpGate = await guardMcpWrite(auth, "runs.cancel");
      if (!cancelMcpGate.ok) return sendJson(res, cancelMcpGate.body, cancelMcpGate.status);
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const runId = typeof body.runId === "string" ? body.runId : null;
      const reason = body.reason;
      if (!runId) return sendError(res, "runs_run_id_required", "runId is required", 400);

      const run = await db.select().from(runs).where(eq(runs.id, runId));
      if (!run[0]) return sendError(res, "runs_run_not_found", "Run not found", 404);
      if (run[0].orgId !== auth.orgId) return sendError(res, "runs_forbidden", "Forbidden", 403);

      if (isTerminalRunStatus(run[0].status)) {
        return sendError(res, "runs_already_terminal", "Run is already {{status}}; cannot cancel", 409, { status: run[0].status });
      }

      await cancelRun(runId, reason);
      await auditAction(auth, "run.cancelled", { targetType: "run", targetId: runId, metadata: { reason } });
      return sendJson(res, { runId, status: "cancelled" });
    } },

  // Replay Lab — standalone sandbox replay. Creates a fresh validation
  // run from ANY source run (not just a DLQ entry) and re-executes the
  // workflow from root nodes. The source run's workflow snapshot is
  // pulled from `workflow_versions.dagJson` (saved workflow) or from
  // `runs.inputJson.workflow` (ad-hoc fallback); an optional caller
  // `suggestedWorkflow` overrides the snapshot and is validated through
  // the same `WorkflowSchema` + `sanitizeAiWorkflow` chain `/dlq/validate-fix`
  // uses. The new run carries `replayMode = "validation"` so the engine's
  // dryRun gating, write-side skips, and rollup exclusions apply
  // automatically; the audit row distinguishes the lab intent from the
  // recovery-dialog intent (`replay_lab.started` vs
  // `recovery.validation_started`).
  { method: "POST", match: "/runs/replay-lab", role: "editor",
    handler: async ({ req, res, auth }) => {
      const { orgConfig } = await orgLlmRuntime(auth.orgId);
      await enforceRateLimit(auth.orgId, { name: "ai", windowMs: RATE_LIMIT_WINDOW_MS, max: orgConfig.ai.rateLimitPerMin });
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));

      const sourceRunId = typeof body.sourceRunId === "string" ? body.sourceRunId : null;
      if (!sourceRunId) return sendError(res, "runs_source_run_id_required", "sourceRunId is required", 400);

      // Org-scope the source run and reject cross-org / unknown ids with
      // an identical 404 envelope — no enumeration leak.
      const sourceRows = await db.select().from(runs).where(and(eq(runs.id, sourceRunId), eq(runs.orgId, auth.orgId)));
      const sourceRun = sourceRows[0];
      if (!sourceRun) return sendError(res, "runs_source_run_not_found", "Source run not found", 404);

      // No nested labs — a sandbox run is itself a validation run; replaying
      // it would just create a sibling sandbox with the same snapshot.
      if (sourceRun.replayMode) {
        return sendError(res, "nested_replay_lab", "Source run is itself a sandbox run; cannot start a nested lab", 400);
      }

      // Resolve the workflow snapshot. Precedence: caller-supplied patch >
      // saved workflow_versions.dagJson > ad-hoc runs.inputJson.workflow.
      let workflow: Workflow;
      const hasPatch = body.suggestedWorkflow !== undefined && body.suggestedWorkflow !== null;
      if (hasPatch) {
        if (typeof body.suggestedWorkflow !== "object") {
          return sendError(res, "runs_suggested_workflow_not_object", "suggestedWorkflow must be an object", 400);
        }
        const parsed = WorkflowSchema.safeParse(body.suggestedWorkflow);
        if (!parsed.success) {
          return sendError(
            res,
            "runs_suggested_workflow_invalid",
            "suggestedWorkflow failed schema validation: {{reason}}",
            400,
            { reason: parsed.error.issues[0]?.message ?? "unknown" },
          );
        }
        try {
          workflow = sanitizeAiWorkflow(parsed.data);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return sendError(res, "runs_suggested_workflow_sanitize_failed", "suggestedWorkflow sanitize failed: {{reason}}", 400, { reason });
        }
      } else {
        // No patch — load the source's own workflow snapshot. Try the saved
        // version first (most common), fall back to the ad-hoc inputJson.
        const versionRows = await db
          .select()
          .from(workflowVersions)
          .where(and(eq(workflowVersions.id, sourceRun.workflowVersionId), eq(workflowVersions.orgId, auth.orgId)));
        const version = versionRows[0];
        let snapshot: unknown = version?.dagJson;
        if (!snapshot) {
          const input = sourceRun.inputJson as Record<string, unknown> | null;
          snapshot = input && typeof input === "object" ? input.workflow : null;
        }
        if (!snapshot) {
          return sendError(res, "no_workflow_snapshot", "Source run has no workflow snapshot available; supply suggestedWorkflow", 400);
        }
        const parsed = WorkflowSchema.safeParse(snapshot);
        if (!parsed.success) {
          return sendError(
            res,
            "invalid_snapshot",
            "Source run snapshot failed schema validation: {{reason}}",
            400,
            { reason: parsed.error.issues[0]?.message ?? "unknown" },
          );
        }
        workflow = parsed.data;
      }

      // Propagate trigger-time input from the source run so workflows
      // that reference `{{input.*}}` behave identically in the sandbox.
      // `startRun` writes `inputJson: { workflow, input }` — read the
      // same key here. Falls back to `{}` for ad-hoc runs whose
      // inputJson predates the input field.
      const sourceInputJson = sourceRun.inputJson as Record<string, unknown> | null;
      const triggerInput = sourceInputJson && typeof sourceInputJson === "object"
        ? sourceInputJson.input
        : undefined;

      const { runId: replayRunId } = await replayRunAsValidation({
        orgId: auth.orgId,
        sourceRunId,
        workflow,
        input: triggerInput,
        createdBy: auth.userId,
        hasPatch,
      });

      await auditAction(auth, "replay_lab.started", { targetType: "run", targetId: sourceRunId, metadata: {
        replayRunId,
        hasPatch,
      } });

      return sendJson(res, { runId: replayRunId });
    } },
  // Targeted Replay Lab fork — re-run a workflow starting at one node
  // instead of from scratch. Predecessors of the fork node are cloned
  // from the source run's terminal state (status='succeeded' with
  // stateJson copied) so the fork node can read upstream outputs without
  // re-paying the cost of HTTP / AI / tool calls that already succeeded.
  // Same `replayMode='validation'` flag as the whole-run replay-lab so
  // the engine's dryRun gate skips write-side effects uniformly.
  // Audit action `replay_lab.fork_started` distinguishes forks from
  // whole-run replays at compliance read time.
  { method: "POST", match: "/runs/replay-lab/fork", role: "editor",
    handler: async ({ req, res, auth }) => {
      const { orgConfig } = await orgLlmRuntime(auth.orgId);
      await enforceRateLimit(auth.orgId, { name: "ai", windowMs: RATE_LIMIT_WINDOW_MS, max: orgConfig.ai.rateLimitPerMin });
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));

      const sourceRunId = typeof body.sourceRunId === "string" ? body.sourceRunId : null;
      if (!sourceRunId) return sendError(res, "invalid_input", "sourceRunId is required", 400);

      const forkNodeId = typeof body.forkNodeId === "string" ? body.forkNodeId : null;
      if (!forkNodeId) return sendError(res, "invalid_input", "forkNodeId is required", 400);

      // Defensive cap on inputOverride size — same shape as the audit
      // metadata cap. Over-cap landings would balloon `run_nodes.stateJson`
      // and `run_events.payload` later; reject up-front with a clear code.
      if (body.inputOverride !== undefined) {
        const overrideBytes = Buffer.byteLength(JSON.stringify(body.inputOverride), "utf8");
        if (overrideBytes > 64_000) {
          return sendError(
            res,
            "override_too_large",
            "inputOverride exceeds 64 KiB cap ({{overrideBytes}} bytes)",
            422,
            { overrideBytes },
          );
        }
      }

      // Org-scope the source run. Cross-org / unknown id → 404 (no enumeration leak).
      const sourceRows = await db.select().from(runs).where(and(eq(runs.id, sourceRunId), eq(runs.orgId, auth.orgId)));
      const sourceRun = sourceRows[0];
      if (!sourceRun) return sendError(res, "not_found", "Source run not found", 404);

      // No nested forks — source run can't itself be a sandbox run.
      if (sourceRun.replayMode) {
        return sendError(res, "nested_replay_lab", "Source run is itself a sandbox run; cannot fork from it", 400);
      }

      // Resolve the workflow snapshot. v1 forks DO NOT accept a patched
      // workflow — they replay the source's own snapshot at the fork node
      // (patches go through the whole-run lab path so the patch validation
      // covers the full DAG). If a future use case wants "fork + patch",
      // it's a separate route.
      const versionRows = await db
        .select()
        .from(workflowVersions)
        .where(and(eq(workflowVersions.id, sourceRun.workflowVersionId), eq(workflowVersions.orgId, auth.orgId)));
      const version = versionRows[0];
      let snapshot: unknown = version?.dagJson;
      if (!snapshot) {
        const input = sourceRun.inputJson as Record<string, unknown> | null;
        snapshot = input && typeof input === "object" ? input.workflow : null;
      }
      if (!snapshot) {
        return sendError(res, "no_workflow_snapshot", "Source run has no workflow snapshot available; cannot fork", 400);
      }
      const parsed = WorkflowSchema.safeParse(snapshot);
      if (!parsed.success) {
        return sendError(
          res,
          "invalid_snapshot",
          "Source run snapshot failed schema validation: {{reason}}",
          400,
          { reason: parsed.error.issues[0]?.message ?? "unknown" },
        );
      }
      const workflow = parsed.data;

      // Propagate trigger-time input so `{{input.*}}` references resolve
      // to the same values the source run saw at predecessors.
      const sourceInputJson = sourceRun.inputJson as Record<string, unknown> | null;
      const triggerInput = sourceInputJson && typeof sourceInputJson === "object"
        ? sourceInputJson.input
        : undefined;

      const result = await replayRunAsValidationFork({
        orgId: auth.orgId,
        sourceRunId,
        workflow,
        forkNodeId,
        inputOverride: body.inputOverride,
        input: triggerInput,
        createdBy: auth.userId,
      });

      if (!result.ok) {
        // Map adapter discriminated errors to HTTP codes. `fork_node_not_found`
        // is a 422 (caller supplied a value the route accepted shape-wise
        // but the workflow doesn't have that node). `predecessor_not_succeeded`
        // is a 422 (we can't fork past an unreliable upstream).
        return sendError(res, result.code, result.message, 422);
      }

      await auditAction(auth, "replay_lab.fork_started", { targetType: "run", targetId: sourceRunId, metadata: {
        replayRunId: result.runId,
        forkNodeId,
        predecessorCount: result.predecessorCount,
        hasOverride: body.inputOverride !== undefined,
      } });

      return sendJson(res, {
        runId: result.runId,
        predecessorCount: result.predecessorCount,
      });
    } },
  // Run comparison — per-node bundle the Replay Lab's comparison view
  // consumes. Both runs are org-scoped via `getRunComparison`; either
  // run missing or not owned by `auth.orgId` returns the same 404
  // envelope (no enumeration leak).
  { method: "GET", match: (url) => url.startsWith("/runs/compare"), role: "viewer",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const baseRunId = url.searchParams.get("baseRunId");
      const replayRunId = url.searchParams.get("replayRunId");
      if (!baseRunId || !replayRunId) {
        return sendError(res, "runs_base_and_replay_run_id_required", "baseRunId and replayRunId are required", 400);
      }
      const result = await getRunComparison({ orgId: auth.orgId, baseRunId, replayRunId });
      if ("error" in result) {
        const message = result.error === "base_run_not_found"
          ? "Base run not found"
          : "Replay run not found";
        return sendError(res, "runs_compare_run_not_found", message, 404);
      }
      return sendJson(res, result);
    } },

  // Causal replay
  { method: "GET", match: (url) => url === "/causal" || url.startsWith("/causal?"), permission: "runs.read",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const runId = url.searchParams.get("runId");
      const eventId = url.searchParams.get("eventId");
      const nodeId = url.searchParams.get("nodeId");
      if (!runId || !eventId || !nodeId) {
        return sendError(res, "runs_run_id_event_id_and_node_id_required", "runId, eventId, and nodeId are required", 400);
      }

      const run = await db.select().from(runs)
        .where(and(eq(runs.id, runId), eq(runs.orgId, auth.orgId)))
        .limit(1);
      if (!run[0]) return sendError(res, "runs_forbidden", "Forbidden", 403);

      const events = await db.select().from(runEvents)
        .where(and(
          eq(runEvents.id, eventId),
          eq(runEvents.runId, runId),
          eq(runEvents.nodeId, nodeId),
          eq(runEvents.type, "decision.made"),
        ))
        .limit(1);
      const decisionEvent = events[0];
      if (!decisionEvent) return sendError(res, "runs_no_decision_event", "No decision event", 404);

      const payload = asRecord(decisionEvent.payload);
      const result = replayDecision({
        chosenNodeId: typeof payload.chosenNodeId === "string" ? payload.chosenNodeId : undefined,
        candidates: decisionCandidatesFromPayload(payload),
        strategy: "auto",
      });

      return sendJson(res, result);
    } },
];

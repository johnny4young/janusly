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

import { and, asc, desc, eq, gt, isNull, lt, or } from "drizzle-orm";

import {
  getOrgConfigSnapshot,
  getRunComparison,
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
import { isTerminalRunStatus } from "@janusly/shared/src/status";

import { decisionCandidatesFromPayload, orgLlmRuntime, sanitizeAiWorkflow } from "../ai-runtime";
import { auditAction } from "../audit-helper";
import { MAX_JSON_BODY_BYTES, RUN_EVENTS_DEFAULT_LIMIT, RUN_EVENTS_MAX_LIMIT } from "../api-config";
import { RATE_LIMIT_WINDOW_MS } from "../constants";
import { asRecord, corsHeaders, readJson, sendEventFrame, sendError, sendJson, sendSseComment } from "../http";
import { paginateRunEvents, parseEventsCursor, parseEventsLimit } from "../run-pagination";
import { enforceRateLimit } from "../rate-limit";
import { getRunStreamHub } from "../run-stream";
import {
  checkRollbackAvailability,
  getCredentialReadinessIssues,
  mergeReadiness,
  productionSecretRefResolver,
} from "../readiness-helpers";
import type { Route } from "../routes";

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

// Summary projection for the `/runs` LIST surfaces. Deliberately excludes
// `inputJson`: it carries the full workflow snapshot captured by `startRun`,
// so a 100-row page would ship 100 workflow JSONs the list never renders.
// The `GET /run?runId=` detail read keeps the full row.
const runListColumns = {
  id: runs.id,
  orgId: runs.orgId,
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

export const runsRoutes: Route[] = [
  // Live run stream (SSE over Redis pub/sub). MUST precede the `/runs` list
  // matcher below — both are GET and `/runs/<id>/stream` starts with `/runs`,
  // so first-match-wins requires this entry first. Events are fanned from the
  // engine's run-event seam through Redis; the per-run channel + the
  // `run.orgId === auth.orgId` gate + the hub's per-publish org re-check are
  // the tenant boundary. Initial timeline history comes from the regular
  // `/run` fetch; this stream carries live signals (and, on reconnect with
  // `Last-Event-ID`, the missed gap).
  { method: "GET", match: (url) => /^\/runs\/[^/?]+\/stream(\?|$)/.test(url), permission: "runs.read",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const runId = decodeURIComponent(url.pathname.split("/")[2] ?? "");
      if (!runId) return sendJson(res, { error: "runId is required" }, 400);

      const run = await db.select().from(runs).where(eq(runs.id, runId));
      if (!run[0] || run[0].orgId !== auth.orgId) return sendJson(res, { error: "Forbidden" }, 403);

      const { runs: runConfig } = await getOrgConfigSnapshot(auth.orgId);

      let torn = false;
      let graceTimer: ReturnType<typeof setTimeout> | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
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

      const writeFrame = (event: PublishedRunEvent) => {
        if (torn || res.writableEnded) return;
        try {
          if (event.kind === "event") {
            sendEventFrame(res, { id: `${event.createdAt}|${event.id}`, event: "run-event", data: event });
          } else {
            sendEventFrame(res, { event: "run-status", data: event });
            if (isTerminalRunStatus(event.status)) armGraceClose();
          }
        } catch {
          // Socket may have closed between the writableEnded check and write.
          // `req.on("close")` will run teardown; nothing else to do here.
        }
      };

      const hub = getRunStreamHub();
      const added = hub.addSubscriber(runId, auth.orgId, writeFrame, runConfig.streamMaxSubscriptions, () => teardown(true));
      if (!added.ok) {
        return sendJson(res, { error: "Too many live run streams for this organization", code: "stream_cap_exceeded" }, 429);
      }
      removeSubscriber = added.remove;

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        // Disable proxy buffering (nginx) so frames flush immediately.
        "X-Accel-Buffering": "no",
        ...corsHeaders(res),
      });
      res.write(`retry: ${STREAM_RETRY_HINT_MS}\n\n`);
      sendSseComment(res, "connected");

      heartbeat = setInterval(() => {
        if (torn || res.writableEnded) return;
        try {
          sendSseComment(res, "keep-alive");
        } catch {
          // ignore — teardown runs on close
        }
      }, STREAM_HEARTBEAT_MS);

      req.on("close", () => teardown(false));

      // Last-Event-ID catch-up: replay the gap since the client's last seen
      // event (ascending keyset after the cursor), then live signals follow.
      // Overlap with live events is harmless — the web dedupes by id.
      // orgId is intentionally NOT in this WHERE: the run was org-gated above
      // (run[0].orgId !== auth.orgId → 403) and run_events are run-scoped, so a
      // cross-tenant runId can't reach here. Don't "simplify" the up-front gate.
      const rawLastId = req.headers["last-event-id"];
      const lastEventId = Array.isArray(rawLastId) ? rawLastId[0] : rawLastId;
      const cursor = parseEventsCursor(lastEventId ?? null);
      if (cursor && !torn) {
        const rows = await db
          .select()
          .from(runEvents)
          .where(and(
            eq(runEvents.runId, runId),
            or(
              gt(runEvents.createdAt, cursor.createdAt),
              and(eq(runEvents.createdAt, cursor.createdAt), gt(runEvents.id, cursor.id)),
            ),
          ))
          .orderBy(asc(runEvents.createdAt), asc(runEvents.id))
          .limit(STREAM_CATCHUP_MAX);
        for (const row of rows) {
          writeFrame({
            kind: "event",
            id: row.id,
            nodeId: row.nodeId,
            type: row.type,
            payload: row.payload,
            createdAt: (row.createdAt ?? new Date()).toISOString(),
          });
        }
      }

      // If the run is ALREADY terminal at connect time, arm the grace close so
      // a reconnecting client to a finished run doesn't hang open forever.
      if (isTerminalRunStatus(run[0].status)) armGraceClose();
    } },

  // Runs — list + reads
  // NOTE: `/runs` prefix excludes `/run?` so the GET `/run?…` entry below
  // can claim it, and excludes `/runs/compare` so the Replay Lab compare
  // route below can claim it (both are first-match-wins).
  // Optional `?workflowId=<id>` filter joins through `workflow_versions` so
  // the caller can scope the listing to one workflow's runs.
  { method: "GET", match: (url) => url.startsWith("/runs") && !url.startsWith("/run?") && !url.startsWith("/runs/compare"),
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const limitParam = Number(url.searchParams.get("limit"));
      const limitValue = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 100;
      const workflowIdFilter = url.searchParams.get("workflowId");

      if (workflowIdFilter) {
        const rows = await db
          .select(runListColumns)
          .from(runs)
          .leftJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
          .where(and(
            eq(runs.orgId, auth.orgId),
            or(
              and(
                eq(workflowVersions.orgId, auth.orgId),
                eq(workflowVersions.workflowId, workflowIdFilter),
              ),
              eq(runs.workflowVersionId, workflowIdFilter),
            ),
          ))
          .orderBy(desc(runs.createdAt))
          .limit(limitValue);
        return sendJson(res, rows);
      }

      const rows = await db.select(runListColumns).from(runs).where(eq(runs.orgId, auth.orgId)).orderBy(desc(runs.createdAt)).limit(limitValue);
      return sendJson(res, rows);
    } },
  { method: "GET", match: (url) => url.startsWith("/run?"),
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const runId = url.searchParams.get("runId");
      if (!runId) return sendJson(res, { error: "runId is required" }, 400);
      const run = await db.select().from(runs).where(eq(runs.id, runId));
      if (!run[0] || run[0].orgId !== auth.orgId) return sendJson(res, { error: "Forbidden" }, 403);
      const nodes = await db.select().from(runNodes).where(eq(runNodes.runId, runId)).orderBy(asc(runNodes.startedAt), asc(runNodes.nodeId));
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
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const runId = url.searchParams.get("runId");
      if (!runId) return sendJson(res, { error: "runId is required" }, 400);
      const run = await db.select().from(runs).where(eq(runs.id, runId));
      if (!run[0] || run[0].orgId !== auth.orgId) return sendJson(res, { error: "Forbidden" }, 403);
      const nodes = await db.select().from(runNodes).where(eq(runNodes.runId, runId)).orderBy(asc(runNodes.startedAt), asc(runNodes.nodeId));
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
      if (!validation.valid) return sendJson(res, { error: "Validation failed", issues: validation.issues }, 400);
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
          return sendJson(res, { error: "Workflow not production-ready", readiness }, 422);
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
        return sendJson(res, { error: "Ad-hoc workflows are disabled. Save the workflow first." }, 403);
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
          return sendJson(res, { error: "Input validation failed", errors: err.errors }, 400);
        }
        throw err;
      }
    } },
  { method: "POST", match: "/resume", role: "editor",
    handler: async ({ req, res, auth }) => {
      const { runId, nodeId, input, resumeToken } = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      if (typeof runId !== "string" || typeof nodeId !== "string") return sendJson(res, { error: "runId and nodeId are required" }, 400);
      const run = await db.select().from(runs).where(eq(runs.id, runId));
      if (!run[0] || run[0].orgId !== auth.orgId) return sendJson(res, { error: "Forbidden" }, 403);
      try {
        const result = await resumeRun(runId, nodeId, {
          input,
          resumeToken: typeof resumeToken === "string" ? resumeToken : undefined,
        });
        await auditAction(auth, "run.resumed", { targetType: "run", targetId: runId, metadata: { nodeId } });
        return sendJson(res, result);
      } catch (err) {
        if (err instanceof WorkflowInputValidationError) {
          return sendJson(res, { error: "Input validation failed", errors: err.errors }, 400);
        }
        if (err instanceof ResumeRunConflictError) {
          return sendJson(res, { error: err.message }, 409);
        }
        if (err instanceof Error && err.message === "resumeToken is required") {
          return sendJson(res, { error: err.message }, 400);
        }
        if (err instanceof Error && err.message === "Invalid resume token") {
          return sendJson(res, { error: "Invalid resume token" }, 403);
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
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const runId = typeof body.runId === "string" ? body.runId : null;
      const reason = body.reason;
      if (!runId) return sendJson(res, { error: "runId is required" }, 400);

      const run = await db.select().from(runs).where(eq(runs.id, runId));
      if (!run[0]) return sendJson(res, { error: "Run not found" }, 404);
      if (run[0].orgId !== auth.orgId) return sendJson(res, { error: "Forbidden" }, 403);

      if (isTerminalRunStatus(run[0].status)) {
        return sendJson(res, { error: `Run is already ${run[0].status}; cannot cancel` }, 409);
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
      if (!sourceRunId) return sendJson(res, { error: "sourceRunId is required" }, 400);

      // Org-scope the source run and reject cross-org / unknown ids with
      // an identical 404 envelope — no enumeration leak.
      const sourceRows = await db.select().from(runs).where(and(eq(runs.id, sourceRunId), eq(runs.orgId, auth.orgId)));
      const sourceRun = sourceRows[0];
      if (!sourceRun) return sendJson(res, { error: "Source run not found" }, 404);

      // No nested labs — a sandbox run is itself a validation run; replaying
      // it would just create a sibling sandbox with the same snapshot.
      if (sourceRun.replayMode) {
        return sendJson(res, { error: "Source run is itself a sandbox run; cannot start a nested lab" }, 400);
      }

      // Resolve the workflow snapshot. Precedence: caller-supplied patch >
      // saved workflow_versions.dagJson > ad-hoc runs.inputJson.workflow.
      let workflow: Workflow;
      const hasPatch = body.suggestedWorkflow !== undefined && body.suggestedWorkflow !== null;
      if (hasPatch) {
        if (typeof body.suggestedWorkflow !== "object") {
          return sendJson(res, { error: "suggestedWorkflow must be an object" }, 400);
        }
        const parsed = WorkflowSchema.safeParse(body.suggestedWorkflow);
        if (!parsed.success) {
          return sendJson(res, {
            error: `suggestedWorkflow failed schema validation: ${parsed.error.issues[0]?.message ?? "unknown"}`,
          }, 400);
        }
        try {
          workflow = sanitizeAiWorkflow(parsed.data);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return sendJson(res, { error: `suggestedWorkflow sanitize failed: ${reason}` }, 400);
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
          return sendJson(res, {
            error: "Source run has no workflow snapshot available; supply suggestedWorkflow",
          }, 400);
        }
        const parsed = WorkflowSchema.safeParse(snapshot);
        if (!parsed.success) {
          return sendJson(res, {
            error: `Source run snapshot failed schema validation: ${parsed.error.issues[0]?.message ?? "unknown"}`,
          }, 400);
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
      if (!sourceRunId) return sendJson(res, { error: "sourceRunId is required", code: "invalid_input" }, 400);

      const forkNodeId = typeof body.forkNodeId === "string" ? body.forkNodeId : null;
      if (!forkNodeId) return sendJson(res, { error: "forkNodeId is required", code: "invalid_input" }, 400);

      // Defensive cap on inputOverride size — same shape as the audit
      // metadata cap. Over-cap landings would balloon `run_nodes.stateJson`
      // and `run_events.payload` later; reject up-front with a clear code.
      if (body.inputOverride !== undefined) {
        const overrideBytes = Buffer.byteLength(JSON.stringify(body.inputOverride), "utf8");
        if (overrideBytes > 64_000) {
          return sendJson(res, {
            error: `inputOverride exceeds 64 KiB cap (${overrideBytes} bytes)`,
            code: "override_too_large",
          }, 422);
        }
      }

      // Org-scope the source run. Cross-org / unknown id → 404 (no enumeration leak).
      const sourceRows = await db.select().from(runs).where(and(eq(runs.id, sourceRunId), eq(runs.orgId, auth.orgId)));
      const sourceRun = sourceRows[0];
      if (!sourceRun) return sendJson(res, { error: "Source run not found", code: "not_found" }, 404);

      // No nested forks — source run can't itself be a sandbox run.
      if (sourceRun.replayMode) {
        return sendJson(res, { error: "Source run is itself a sandbox run; cannot fork from it", code: "nested_replay_lab" }, 400);
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
        return sendJson(res, {
          error: "Source run has no workflow snapshot available; cannot fork",
          code: "no_workflow_snapshot",
        }, 400);
      }
      const parsed = WorkflowSchema.safeParse(snapshot);
      if (!parsed.success) {
        return sendJson(res, {
          error: `Source run snapshot failed schema validation: ${parsed.error.issues[0]?.message ?? "unknown"}`,
          code: "invalid_snapshot",
        }, 400);
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
        return sendJson(res, {
          error: result.message,
          code: result.code,
          details: "details" in result ? result.details : undefined,
        }, 422);
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
        return sendJson(res, { error: "baseRunId and replayRunId are required" }, 400);
      }
      const result = await getRunComparison({ orgId: auth.orgId, baseRunId, replayRunId });
      if ("error" in result) {
        const message = result.error === "base_run_not_found"
          ? "Base run not found"
          : "Replay run not found";
        return sendJson(res, { error: message }, 404);
      }
      return sendJson(res, result);
    } },

  // Causal replay
  { method: "GET", match: (url) => url.startsWith("/causal"),
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const runId = url.searchParams.get("runId");
      const nodeId = url.searchParams.get("nodeId");
      if (!runId || !nodeId) return sendJson(res, { error: "runId and nodeId are required" }, 400);

      const run = await db.select().from(runs).where(eq(runs.id, runId));
      if (!run[0] || run[0].orgId !== auth.orgId) return sendJson(res, { error: "Forbidden" }, 403);

      const events = await db.select().from(runEvents).where(eq(runEvents.runId, runId));
      const decisionEvent = events.find(event => event.type === "decision.made" && event.nodeId === nodeId);
      if (!decisionEvent) return sendJson(res, { error: "No decision event" }, 404);

      const payload = asRecord(decisionEvent.payload);
      const result = replayDecision({
        chosenNodeId: typeof payload.chosenNodeId === "string" ? payload.chosenNodeId : undefined,
        candidates: decisionCandidatesFromPayload(payload),
        strategy: "auto",
      });

      return sendJson(res, result);
    } },
];

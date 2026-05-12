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

import { and, asc, desc, eq, gt, lt, or } from "drizzle-orm";

import { getOrgConfigSnapshot } from "@janusly/data/src/orgConfigRepo";
import { db, runEvents, runNodes, runs, workflows, workflowVersions } from "@janusly/db";
import { replayDecision } from "@janusly/domain";
import { WorkflowInputValidationError } from "@janusly/engine/src/inputs-validator";
import { cancelRun } from "@janusly/engine/src/persistence";
import { ResumeRunConflictError, resumeRun } from "@janusly/engine/src/resume-run";
import { startRun } from "@janusly/engine/src/start-run";
import { checkWorkflowReadiness } from "@janusly/engine/src/workflow-readiness";
import { validateWorkflow } from "@janusly/engine/src/workflow-validation";
import { WorkflowSchema } from "@janusly/shared";
import { isTerminalRunStatus } from "@janusly/shared/src/status";

import { decisionCandidatesFromPayload } from "../ai-runtime";
import { audit } from "../audit";
import { MAX_JSON_BODY_BYTES, RUN_EVENTS_DEFAULT_LIMIT, RUN_EVENTS_MAX_LIMIT } from "../api-config";
import { asRecord, corsHeaders, readJson, sendEvent, sendJson } from "../http";
import { paginateRunEvents, parseEventsCursor, parseEventsLimit } from "../run-pagination";
import { checkRollbackAvailability, mergeReadiness } from "../readiness-helpers";
import type { Route } from "../routes";

export const runsRoutes: Route[] = [
  // Runs — list + reads
  // NOTE: `/runs` prefix excludes `/run?` so the next entry can claim it.
  // Optional `?workflowId=<id>` filter joins through `workflow_versions` so
  // the caller can scope the listing to one workflow's runs.
  { method: "GET", match: (url) => url.startsWith("/runs") && !url.startsWith("/run?"),
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const limitParam = Number(url.searchParams.get("limit"));
      const limitValue = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 100;
      const workflowIdFilter = url.searchParams.get("workflowId");

      if (workflowIdFilter) {
        const rows = await db
          .select({
            id: runs.id,
            orgId: runs.orgId,
            workflowVersionId: runs.workflowVersionId,
            status: runs.status,
            inputJson: runs.inputJson,
            outputJson: runs.outputJson,
            parentRunId: runs.parentRunId,
            parentNodeId: runs.parentNodeId,
            traceId: runs.traceId,
            replayMode: runs.replayMode,
            createdBy: runs.createdBy,
            createdAt: runs.createdAt,
          })
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

      const rows = await db.select().from(runs).where(eq(runs.orgId, auth.orgId)).orderBy(desc(runs.createdAt)).limit(limitValue);
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
  { method: "GET", match: (url) => url.startsWith("/events"),
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const runId = url.searchParams.get("runId");
      if (!runId) return sendJson(res, { error: "runId is required" }, 400);
      const run = await db.select().from(runs).where(eq(runs.id, runId));
      if (!run[0] || run[0].orgId !== auth.orgId) return sendJson(res, { error: "Forbidden" }, 403);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", ...corsHeaders(res) });
      let lastSeen: Date | null = null;
      let closed = false;
      const tick = async () => {
        if (closed) return;
        const filter = lastSeen
          ? and(eq(runEvents.runId, runId), gt(runEvents.createdAt, lastSeen))
          : eq(runEvents.runId, runId);
        const events = await db.select().from(runEvents).where(filter).orderBy(asc(runEvents.createdAt));
        if (closed) return;
        if (events.length) {
          lastSeen = events[events.length - 1].createdAt ?? lastSeen;
          sendEvent(res, events);
        }
      };
      const interval = setInterval(() => { void tick(); }, 1000);
      void tick();
      req.on("close", () => {
        closed = true;
        clearInterval(interval);
      });
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
        const rollbackIssues = await checkRollbackAvailability(auth.orgId, parsedWorkflow.id);
        const readiness = mergeReadiness(baseReadiness, rollbackIssues);
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
          .where(and(eq(workflows.id, parsedWorkflow.id), eq(workflows.orgId, auth.orgId)));
        isAdhoc = owned.length === 0;
      }
      if (requireSaved && isAdhoc) {
        return sendJson(res, { error: "Ad-hoc workflows are disabled. Save the workflow first." }, 403);
      }

      try {
        const result = await startRun({
          ...parsedWorkflow,
          input: inputValue,
          orgId: auth.orgId,
          createdBy: auth.userId,
        });
        await audit(auth.orgId, auth.userId, isAdhoc ? "run.started.adhoc" : "run.started", "run", result.runId, {
          workflowId: parsedWorkflow.id,
          adhoc: isAdhoc,
        });
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
        await audit(auth.orgId, auth.userId, "run.resumed", "run", runId, { nodeId });
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
  { method: "POST", match: "/run/cancel", role: "editor",
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
      await audit(auth.orgId, auth.userId, "run.cancelled", "run", runId, { reason });
      return sendJson(res, { runId, status: "cancelled" });
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

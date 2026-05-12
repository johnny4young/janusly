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
import { getRunComparison } from "@janusly/data/src/runComparisonRepo";
import { db, runEvents, runNodes, runs, workflows, workflowVersions } from "@janusly/db";
import { replayDecision } from "@janusly/domain";
import { replayRunAsValidation } from "@janusly/engine/src/adapters/replay-lab";
import { WorkflowInputValidationError } from "@janusly/engine/src/inputs-validator";
import { cancelRun } from "@janusly/engine/src/persistence";
import { ResumeRunConflictError, resumeRun } from "@janusly/engine/src/resume-run";
import { startRun } from "@janusly/engine/src/start-run";
import { checkWorkflowReadiness } from "@janusly/engine/src/workflow-readiness";
import { validateWorkflow } from "@janusly/engine/src/workflow-validation";
import { WorkflowSchema, type Workflow } from "@janusly/shared";
import { isTerminalRunStatus } from "@janusly/shared/src/status";

import { decisionCandidatesFromPayload, orgLlmRuntime, sanitizeAiWorkflow } from "../ai-runtime";
import { audit } from "../audit";
import { MAX_JSON_BODY_BYTES, RUN_EVENTS_DEFAULT_LIMIT, RUN_EVENTS_MAX_LIMIT } from "../api-config";
import { asRecord, corsHeaders, readJson, sendEvent, sendJson } from "../http";
import { paginateRunEvents, parseEventsCursor, parseEventsLimit } from "../run-pagination";
import { enforceRateLimit } from "../rate-limit";
import { checkRollbackAvailability, mergeReadiness } from "../readiness-helpers";
import type { Route } from "../routes";

export const runsRoutes: Route[] = [
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
      await enforceRateLimit(auth.orgId, { name: "ai", windowMs: 60_000, max: orgConfig.ai.rateLimitPerMin });
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

      await audit(auth.orgId, auth.userId, "replay_lab.started", "run", sourceRunId, {
        replayRunId,
        hasPatch,
      });

      return sendJson(res, { runId: replayRunId });
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

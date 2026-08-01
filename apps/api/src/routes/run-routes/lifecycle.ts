/** Run start, resume, and cancellation routes. */

import { and, eq, isNull } from "drizzle-orm";

import {
  getOrgConfigSnapshot,
  getWorkflowStatus,
  resolveWorkflowPauseAction,
  resolveWorkflowRolloutAssignment,
} from "@janusly/data";
import { db, runs, workflows } from "@janusly/db";
import { WorkflowInputValidationError } from "@janusly/engine/src/inputs-validator";
import { cancelRun } from "@janusly/engine/src/persistence";
import { ResumeRunConflictError, resumeRun } from "@janusly/engine/src/resume-run";
import { startRun } from "@janusly/engine/src/start-run";
import { checkWorkflowReadiness } from "@janusly/engine/src/workflow-readiness";
import { validateWorkflow } from "@janusly/engine/src/workflow-validation";
import { WorkflowSchema } from "@janusly/shared";
import { isTerminalRunStatus } from "@janusly/shared/src/status";

import { MAX_JSON_BODY_BYTES } from "../../api-config";
import {
  cancelRunContract,
  resumeRunContract,
  startRunContract,
} from "../../api-contracts";
import { auditAction } from "../../audit-helper";
import { asRecord, readJson, sendError, sendJson } from "../../http";
import { guardMcpWrite } from "../../mcp-consent";
import {
  checkRollbackAvailability,
  getCredentialReadinessIssues,
  mergeReadiness,
  productionSecretRefResolver,
} from "../../readiness-helpers";
import type { Route } from "../../routes";

export const runLifecycleRoutes: Route[] = [
  // Run lifecycle (start / resume / cancel)
  { method: "POST", match: "/start", role: "editor", permission: "runs.start", contract: startRunContract,
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
      const requestedWorkflowId = typeof workflow.id === "string" ? workflow.id : null;
      const rolloutAssignment = requestedWorkflowId
        ? await resolveWorkflowRolloutAssignment({
            orgId: auth.orgId,
            workflowId: requestedWorkflowId,
            assignmentKey: crypto.randomUUID(),
          })
        : null;
      const effectiveWorkflow = rolloutAssignment?.workflow ?? workflow;
      // Explicit operator override to start a run even when the workflow is
      // paused by an upstream-health degradation. Surfaced as the "Force run"
      // button on the paused-workflow UI; audited separately so the override
      // is traceable.
      const forceRunDuringPause = body.forceRunDuringPause === true;

      const validation = validateWorkflow(effectiveWorkflow);
      if (!validation.valid) return sendError(res, "runs_validation_failed", "Validation failed", 400);
      const parsedWorkflow = WorkflowSchema.parse(effectiveWorkflow);

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
        // Shared decision table (workflowPausePolicy.ts): /start REJECTS,
        // naming the actual pause cause — breaker vs upstream send the
        // operator to different places.
        const pauseAction = resolveWorkflowPauseAction(wfStatus?.status, "start");
        if (wfStatus && pauseAction.kind === "reject") {
          if (!forceRunDuringPause) {
            return sendError(
              res,
              pauseAction.code,
              wfStatus.pausedReason ?? "Workflow is paused because an upstream dependency is degraded",
              409,
              { status: pauseAction.status },
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
          ...(rolloutAssignment
            ? {
                versionId: rolloutAssignment.versionId,
                rollout: {
                  id: rolloutAssignment.rollout.id,
                  variant: rolloutAssignment.variant,
                },
              }
            : {}),
        });
        await auditAction(auth, isAdhoc ? "run.started.adhoc" : "run.started", { targetType: "run", targetId: result.runId, metadata: {
          workflowId: parsedWorkflow.id,
          adhoc: isAdhoc,
          ...(rolloutAssignment
            ? {
                workflowVersionId: rolloutAssignment.versionId,
                workflowRolloutId: rolloutAssignment.rollout.id,
                workflowRolloutVariant: rolloutAssignment.variant,
              }
            : {}),
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
  { method: "POST", match: "/resume", role: "editor", permission: "runs.start", contract: resumeRunContract,
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
  { method: "POST", match: "/run/cancel", role: "editor", permission: "runs.cancel", contract: cancelRunContract,
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

];

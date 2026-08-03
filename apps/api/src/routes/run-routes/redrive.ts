/** Production run redrive route. */

import { and, desc, eq, isNull } from "drizzle-orm";

import { db, runNodes, runs, workflows, workflowVersions } from "@janusly/db";
import { redriveRun } from "@janusly/engine/src/adapters/redrive";
import { checkWorkflowReadiness } from "@janusly/engine/src/workflow-readiness";
import { WorkflowSchema } from "@janusly/shared";

import { MAX_JSON_BODY_BYTES } from "../../api-config";
import { redriveRunContract } from "../../api-contracts";
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

export const runRedriveRoutes: Route[] = [
  // Production redrive — resume a FAILED run from its failed node on the
  // latest (or an explicit) saved workflow version, reusing every upstream
  // output that already succeeded. The wedge's last mile: DLQ → patch →
  // save v(n+1) → redrive continues the work instead of re-running it.
  { method: "POST", match: "/runs/redrive", role: "editor", permission: "runs.start", contract: redriveRunContract,
    handler: async ({ req, res, auth }) => {
      const redriveMcpGate = await guardMcpWrite(auth, "runs.redrive");
      if (!redriveMcpGate.ok) return sendJson(res, redriveMcpGate.body, redriveMcpGate.status);
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const runId = typeof body.runId === "string" ? body.runId : null;
      if (!runId) return sendError(res, "runs_run_id_required", "runId is required", 400);
      const requestedNodeId = typeof body.nodeId === "string" && body.nodeId.length > 0 ? body.nodeId : null;
      const requestedVersionId = typeof body.workflowVersionId === "string" && body.workflowVersionId.length > 0
        ? body.workflowVersionId
        : null;

      const sourceRows = await db.select().from(runs).where(eq(runs.id, runId));
      const sourceRun = sourceRows[0];
      if (!sourceRun || sourceRun.orgId !== auth.orgId) {
        return sendError(res, "runs_forbidden", "Forbidden", 403);
      }
      if (sourceRun.status !== "failed") {
        return sendError(res, "runs_redrive_source_not_failed", "Only a failed run can be redriven", 409);
      }

      // Resolve the failed node: explicit `nodeId` must actually be failed;
      // otherwise exactly one failed node is required (ambiguity → 400 with
      // the candidate list so the client can re-ask precisely).
      const nodeRows = await db
        .select({ nodeId: runNodes.nodeId, status: runNodes.status })
        .from(runNodes)
        .where(eq(runNodes.runId, runId));
      const failedNodeIds = nodeRows.filter((row) => row.status === "failed").map((row) => row.nodeId);
      if (failedNodeIds.length === 0) {
        return sendError(res, "runs_redrive_source_not_failed", "The run has no failed node to resume from", 409);
      }
      let failedNodeId: string;
      if (requestedNodeId) {
        if (!failedNodeIds.includes(requestedNodeId)) {
          return sendError(res, "runs_redrive_node_not_failed", "nodeId is not a failed node of this run", 400, { nodeId: requestedNodeId });
        }
        failedNodeId = requestedNodeId;
      } else if (failedNodeIds.length > 1) {
        return sendError(res, "runs_redrive_node_ambiguous", "Multiple failed nodes — pass nodeId", 400, { nodeIds: failedNodeIds.join(", ") });
      } else {
        failedNodeId = failedNodeIds[0]!;
      }

      // Resolve the TARGET version. The source run's version row anchors the
      // workflow id; an ad-hoc run (synthetic version id, no row) has no
      // saved lineage to redrive onto — that's what /dlq/replay covers.
      const sourceVersionRows = await db
        .select({ workflowId: workflowVersions.workflowId })
        .from(workflowVersions)
        .where(and(eq(workflowVersions.id, sourceRun.workflowVersionId), eq(workflowVersions.orgId, auth.orgId)));
      const workflowId = sourceVersionRows[0]?.workflowId;
      if (!workflowId) {
        return sendError(res, "runs_redrive_requires_saved_workflow", "Redrive needs a saved workflow version — this run was ad-hoc", 409);
      }
      const workflowRows = await db
        .select({ id: workflows.id, status: workflows.status })
        .from(workflows)
        .where(and(eq(workflows.id, workflowId), eq(workflows.orgId, auth.orgId), isNull(workflows.deletedAt)));
      const workflowRow = workflowRows[0];
      if (!workflowRow) return sendError(res, "workflow_not_found", "Workflow not found", 404);
      if (workflowRow.status !== "active") {
        return sendError(res, "runs_redrive_workflow_paused", "Workflow is paused — restore it before redriving", 409);
      }

      let targetVersionRow: { id: string; workflowId: string; dagJson: unknown } | undefined;
      if (requestedVersionId) {
        const rows = await db
          .select({ id: workflowVersions.id, workflowId: workflowVersions.workflowId, dagJson: workflowVersions.dagJson })
          .from(workflowVersions)
          .where(and(eq(workflowVersions.id, requestedVersionId), eq(workflowVersions.orgId, auth.orgId)));
        targetVersionRow = rows[0];
        if (!targetVersionRow || targetVersionRow.workflowId !== workflowId) {
          return sendError(res, "runs_redrive_version_not_found", "workflowVersionId does not belong to this run's workflow", 404);
        }
      } else {
        const rows = await db
          .select({ id: workflowVersions.id, workflowId: workflowVersions.workflowId, dagJson: workflowVersions.dagJson })
          .from(workflowVersions)
          .where(and(eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.orgId, auth.orgId)))
          .orderBy(desc(workflowVersions.version))
          .limit(1);
        targetVersionRow = rows[0];
        if (!targetVersionRow) {
          return sendError(res, "runs_redrive_requires_saved_workflow", "Redrive needs a saved workflow version", 409);
        }
      }

      const parsedTarget = WorkflowSchema.safeParse(targetVersionRow.dagJson);
      if (!parsedTarget.success) {
        return sendError(res, "runs_redrive_version_invalid", "Target version failed schema validation", 422);
      }
      // Same production-mode posture as POST /start: fail-level readiness
      // issues block a redrive that would execute write-side work.
      if (process.env.JANUSLY_PRODUCTION_MODE === "true") {
        const baseReadiness = checkWorkflowReadiness(parsedTarget.data);
        const [rollbackIssues, credentialIssues] = await Promise.all([
          checkRollbackAvailability(auth.orgId, parsedTarget.data.id),
          getCredentialReadinessIssues(auth.orgId, parsedTarget.data, productionSecretRefResolver),
        ]);
        const readiness = mergeReadiness(baseReadiness, [...rollbackIssues, ...credentialIssues]);
        if (readiness.status === "fail") {
          return sendError(res, "runs_not_production_ready", "Workflow not production-ready", 422);
        }
      }

      const sourceEnvelope = asRecord(sourceRun.inputJson);
      const sourceInput = Object.hasOwn(sourceEnvelope, "input")
        ? sourceEnvelope.input
        : {};
      const result = await redriveRun({
        orgId: auth.orgId,
        sourceRunId: runId,
        failedNodeId,
        workflow: parsedTarget.data,
        targetWorkflowVersionId: targetVersionRow.id,
        input: sourceInput,
        createdBy: auth.userId,
        traceId: sourceRun.traceId,
      });
      if (!result.ok) {
        const code = result.code === "node_not_in_version"
          ? "runs_redrive_node_missing_in_version"
          : "runs_redrive_predecessor_not_succeeded";
        return sendError(res, code, result.message, 409);
      }

      if (result.wasCreated) {
        await auditAction(auth, "run.redrive", { targetType: "run", targetId: result.runId, metadata: {
          sourceRunId: runId,
          failedNodeId,
          targetWorkflowVersionId: targetVersionRow.id,
          predecessorCount: result.predecessorCount,
        } });
      }
      return sendJson(res, { runId: result.runId });
    } },
];

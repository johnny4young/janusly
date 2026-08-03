/**
 * Workflow deployment controls for baseline/canary traffic splitting.
 *
 * The data repository owns version compatibility, deterministic assignment,
 * atomic counters, and automatic rollback. These handlers provide bounded
 * admin lifecycle controls and a read-only operator projection.
 */

import { z } from "zod";

import {
  createWorkflowRollout,
  findWorkflowRecoveryQualification,
  finishWorkflowRollout,
  getLatestWorkflowRollout,
  recordWorkflowRecoveryQualification,
  resolveWorkflowRecoveryQualificationVersions,
  WORKFLOW_ROLLOUT_SAMPLE_MAX,
  WORKFLOW_ROLLOUT_SAMPLE_MIN,
  WORKFLOW_ROLLOUT_SUCCESS_RATE_MAX,
  WORKFLOW_ROLLOUT_SUCCESS_RATE_MIN,
  WORKFLOW_ROLLOUT_TRAFFIC_MAX,
  WORKFLOW_ROLLOUT_TRAFFIC_MIN,
  type WorkflowRollout,
} from "@janusly/data";
import {
  qualifyRecoveryCandidate,
  toRecoveryQualificationReceiptSummary,
} from "@janusly/engine";
import { RECOVERY_QUALIFICATION_DATASET_VERSION } from "@janusly/shared";

import { auditAction } from "../audit-helper";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { readJson, sendError, sendJson } from "../http";
import type { Route } from "../routes";

const ROOT_PATH = /^\/workflows\/([^/?]+)\/rollout(?:\?.*)?$/;
const QUALIFICATION_PATH =
  /^\/workflows\/([^/?]+)\/rollout\/qualification(?:\?.*)?$/;
const DECISION_PATH = /^\/workflows\/([^/?]+)\/rollout\/([^/?]+)\/([^/?]+)(?:\?|$)/;

const CreateBodySchema = z.object({
  baselineVersionId: z.string().trim().min(1).max(255),
  canaryVersionId: z.string().trim().min(1).max(255),
  trafficPercent: z.number().int().min(WORKFLOW_ROLLOUT_TRAFFIC_MIN).max(WORKFLOW_ROLLOUT_TRAFFIC_MAX),
  minimumSampleSize: z.number().int().min(WORKFLOW_ROLLOUT_SAMPLE_MIN).max(WORKFLOW_ROLLOUT_SAMPLE_MAX),
  minimumSuccessRatePercent: z.number().int()
    .min(WORKFLOW_ROLLOUT_SUCCESS_RATE_MIN)
    .max(WORKFLOW_ROLLOUT_SUCCESS_RATE_MAX),
}).strict();

const DecisionBodySchema = z.object({
  reason: z.string().trim().max(500).optional(),
}).strict();

const QualificationBodySchema = z.object({
  baselineVersionId: z.string().trim().min(1).max(255),
  candidateVersionId: z.string().trim().min(1).max(255),
}).strict();

function decodePathPart(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const decoded = decodeURIComponent(value).trim();
    return decoded || null;
  } catch {
    return null;
  }
}

function projectRollout(rollout: WorkflowRollout) {
  return {
    id: rollout.id,
    workflowId: rollout.workflowId,
    baselineVersionId: rollout.baselineVersionId,
    canaryVersionId: rollout.canaryVersionId,
    trafficPercent: rollout.trafficPercent,
    minimumSampleSize: rollout.minimumSampleSize,
    minimumSuccessRatePercent: rollout.minimumSuccessRatePercent,
    status: rollout.status,
    baselineSucceeded: rollout.baselineSucceeded,
    baselineFailed: rollout.baselineFailed,
    canarySucceeded: rollout.canarySucceeded,
    canaryFailed: rollout.canaryFailed,
    rolledBackReason: rollout.rolledBackReason,
    createdAt: rollout.createdAt,
    updatedAt: rollout.updatedAt,
    endedAt: rollout.endedAt,
    lastOutcomeAt: rollout.lastOutcomeAt,
  };
}

function projectQualification(
  qualification: NonNullable<
    Awaited<ReturnType<typeof findWorkflowRecoveryQualification>>
  >,
) {
  return {
    id: qualification.id,
    workflowId: qualification.workflowId,
    baselineVersionId: qualification.baselineVersionId,
    candidateVersionId: qualification.candidateVersionId,
    datasetVersion: qualification.datasetVersion,
    datasetDigest: qualification.datasetDigest,
    mode: qualification.mode,
    status: qualification.status,
    summary: qualification.summaryJson,
    createdAt: qualification.createdAt,
  };
}

function qualificationPairFromUrl(
  url: string | undefined,
): { baselineVersionId: string; candidateVersionId: string } | null {
  try {
    const parsed = new URL(url ?? "", "http://janusly.local");
    const result = QualificationBodySchema.safeParse({
      baselineVersionId: parsed.searchParams.get("baselineVersionId"),
      candidateVersionId: parsed.searchParams.get("candidateVersionId"),
    });
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export const workflowRolloutsRoutes: Route[] = [
  {
    method: "GET",
    match: (url) => QUALIFICATION_PATH.test(url),
    permission: "workflows.read",
    handler: async ({ req, res, auth }) => {
      const workflowId = decodePathPart(
        QUALIFICATION_PATH.exec(req.url ?? "")?.[1],
      );
      const pair = qualificationPairFromUrl(req.url);
      if (!workflowId || !pair) {
        return sendError(
          res,
          "workflow_recovery_qualification_invalid",
          "Recovery qualification version pair is invalid",
          400,
        );
      }
      const resolved = await resolveWorkflowRecoveryQualificationVersions({
        orgId: auth.orgId,
        workflowId,
        ...pair,
      });
      if (resolved.kind === "not_found") {
        return sendError(
          res,
          "workflow_not_found",
          "Workflow not found",
          404,
        );
      }
      if (resolved.kind !== "resolved") {
        return sendError(
          res,
          "workflow_recovery_qualification_invalid",
          "Workflow versions are not eligible for qualification",
          422,
          { reason: resolved.kind },
        );
      }
      const required =
        resolved.baseline.workflow.recovery?.contract?.version === "2"
        || resolved.candidate.workflow.recovery?.contract?.version === "2";
      const qualification = required
        ? await findWorkflowRecoveryQualification({
            orgId: auth.orgId,
            workflowId,
            ...pair,
            datasetVersion: RECOVERY_QUALIFICATION_DATASET_VERSION,
          })
        : null;
      return sendJson(res, {
        required,
        qualification: qualification
          ? projectQualification(qualification)
          : null,
      });
    },
  },
  {
    method: "POST",
    match: (url) => QUALIFICATION_PATH.test(url),
    role: "admin",
    permission: "workflows.write",
    handler: async ({ req, res, auth }) => {
      const workflowId = decodePathPart(
        QUALIFICATION_PATH.exec(req.url ?? "")?.[1],
      );
      const pair = QualificationBodySchema.safeParse(
        await readJson(req, MAX_JSON_BODY_BYTES),
      );
      if (!workflowId || !pair.success) {
        return sendError(
          res,
          "workflow_recovery_qualification_invalid",
          "Recovery qualification version pair is invalid",
          400,
        );
      }
      const resolved = await resolveWorkflowRecoveryQualificationVersions({
        orgId: auth.orgId,
        workflowId,
        ...pair.data,
      });
      if (resolved.kind === "not_found") {
        return sendError(
          res,
          "workflow_not_found",
          "Workflow not found",
          404,
        );
      }
      if (resolved.kind !== "resolved") {
        return sendError(
          res,
          "workflow_recovery_qualification_invalid",
          "Workflow versions are not eligible for qualification",
          422,
          { reason: resolved.kind },
        );
      }

      const summary = qualifyRecoveryCandidate({
        baseline: resolved.baseline.workflow,
        candidate: resolved.candidate.workflow,
      });
      if (
        summary.status === "not_required"
        || summary.mode === "not_required"
      ) {
        return sendJson(res, {
          required: false,
          qualification: null,
          summary,
        });
      }
      const qualification = await recordWorkflowRecoveryQualification({
        orgId: auth.orgId,
        workflowId,
        baselineVersionId: resolved.baseline.id,
        candidateVersionId: resolved.candidate.id,
        datasetVersion: summary.datasetVersion,
        datasetDigest: summary.datasetDigest,
        mode: summary.mode,
        status: summary.status,
        summaryJson: toRecoveryQualificationReceiptSummary(summary),
        createdBy: auth.userId,
      });
      await auditAction(
        auth,
        "workflow.recovery_qualification.recorded",
        {
          targetType: "workflow_recovery_qualification",
          targetId: qualification.id,
          metadata: {
            workflowId,
            baselineVersionId: resolved.baseline.id,
            candidateVersionId: resolved.candidate.id,
            datasetVersion: summary.datasetVersion,
            datasetDigest: summary.datasetDigest,
            mode: summary.mode,
            status: summary.status,
            candidateAssertionCount:
              summary.candidateAssertionCount,
            failedCandidateAssertions:
              summary.failedCandidateAssertions,
            regressionCount: summary.regressionCount,
          },
        },
      );
      return sendJson(res, {
        required: true,
        qualification: projectQualification(qualification),
      });
    },
  },
  {
    method: "GET",
    match: (url) => ROOT_PATH.test(url),
    permission: "workflows.read",
    handler: async ({ req, res, auth }) => {
      const workflowId = decodePathPart(ROOT_PATH.exec(req.url ?? "")?.[1]);
      if (!workflowId) return sendError(res, "workflows_workflow_id_required", "workflowId is required", 400);
      const rollout = await getLatestWorkflowRollout(auth.orgId, workflowId);
      return sendJson(res, { rollout: rollout ? projectRollout(rollout) : null });
    },
  },
  {
    method: "POST",
    match: (url) => ROOT_PATH.test(url) && !DECISION_PATH.test(url),
    role: "admin",
    permission: "workflows.write",
    handler: async ({ req, res, auth }) => {
      const workflowId = decodePathPart(ROOT_PATH.exec(req.url ?? "")?.[1]);
      if (!workflowId) return sendError(res, "workflows_workflow_id_required", "workflowId is required", 400);
      const body = CreateBodySchema.safeParse(await readJson(req, MAX_JSON_BODY_BYTES));
      if (!body.success) {
        return sendError(res, "workflow_rollout_invalid", "Workflow rollout settings are invalid", 400);
      }
      const result = await createWorkflowRollout({
        orgId: auth.orgId,
        workflowId,
        ...body.data,
        createdBy: auth.userId,
      });
      if (result.kind === "not_found") {
        return sendError(res, "workflow_not_found", "Workflow not found", 404);
      }
      if (result.kind === "active_exists") {
        return sendError(res, "workflow_rollout_active", "This workflow already has an active rollout", 409);
      }
      if (result.kind === "recovery_qualification_required") {
        return sendError(
          res,
          "workflow_recovery_qualification_required",
          "Pass the semantic outcome dataset comparison before starting this rollout",
          409,
        );
      }
      if (result.kind !== "created") {
        return sendError(
          res,
          "workflow_rollout_invalid",
          "Workflow versions are not eligible for a rollout",
          422,
          { reason: result.kind },
        );
      }
      await auditAction(auth, "workflow.rollout.started", {
        targetType: "workflow_rollout",
        targetId: result.rollout.id,
        metadata: {
          workflowId,
          baselineVersionId: result.rollout.baselineVersionId,
          canaryVersionId: result.rollout.canaryVersionId,
          trafficPercent: result.rollout.trafficPercent,
          minimumSampleSize: result.rollout.minimumSampleSize,
          minimumSuccessRatePercent: result.rollout.minimumSuccessRatePercent,
        },
      });
      return sendJson(res, { rollout: projectRollout(result.rollout) }, 201);
    },
  },
  {
    method: "POST",
    match: (url) => DECISION_PATH.test(url),
    role: "admin",
    permission: "workflows.write",
    handler: async ({ req, res, auth }) => {
      const match = DECISION_PATH.exec(req.url ?? "");
      const workflowId = decodePathPart(match?.[1]);
      const rolloutId = decodePathPart(match?.[2]);
      const decision = match?.[3] === "promote" ? "promote" : match?.[3] === "rollback" ? "rollback" : null;
      if (!workflowId || !rolloutId || !decision) {
        return sendError(res, "workflow_rollout_invalid", "Workflow rollout path is invalid", 400);
      }
      const body = DecisionBodySchema.safeParse(await readJson(req, MAX_JSON_BODY_BYTES));
      if (!body.success) {
        return sendError(res, "workflow_rollout_invalid", "Workflow rollout decision is invalid", 400);
      }
      const result = await finishWorkflowRollout({
        orgId: auth.orgId,
        workflowId,
        rolloutId,
        decision,
        reason: body.data.reason,
      });
      if (result.kind === "not_found") {
        return sendError(res, "workflow_rollout_not_found", "Workflow rollout not found", 404);
      }
      if (result.kind === "not_active") {
        return sendError(res, "workflow_rollout_not_active", "Workflow rollout is no longer active", 409);
      }
      await auditAction(
        auth,
        decision === "promote" ? "workflow.rollout.promoted" : "workflow.rollout.rolled_back",
        {
          targetType: "workflow_rollout",
          targetId: result.rollout.id,
          metadata: {
            workflowId,
            baselineVersionId: result.rollout.baselineVersionId,
            canaryVersionId: result.rollout.canaryVersionId,
            reason: result.rollout.rolledBackReason,
          },
        },
      );
      return sendJson(res, { rollout: projectRollout(result.rollout) });
    },
  },
];

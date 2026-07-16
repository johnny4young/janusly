/**
 * Evidence-gated Recovery Playbook lifecycle and explicit-use routes.
 *
 * A playbook can be promoted only from server-verifiable recovery evidence:
 * non-empty patch evidence, a successful validation run, the exact saved DAG,
 * a replayed dead letter, and accepted operator feedback. Reuse returns the
 * immutable source snapshot but never applies it; the Recovery dialog must run
 * `/dlq/validate-fix` again and preserve its separate production Apply click.
 */

import { z } from "zod";

import {
  activateRecoveryPlaybook,
  createRecoveryPlaybookDraft,
  findMatchingActiveRecoveryPlaybook,
  RECOVERY_PLAYBOOK_INSTRUCTIONS_MAX_CHARS,
  RECOVERY_PLAYBOOK_TITLE_MAX_CHARS,
  recordRecoveryPlaybookApplied,
  recordRecoveryPlaybookValidationOutcome,
  resolveRecoveryPlaybookOutcomeFacts,
  resolveRecoveryPlaybookPromotionEvidence,
  retireRecoveryPlaybook,
  type RecoveryPlaybook,
} from "@janusly/data";
import { computeWorkflowDiff } from "@janusly/shared/src/workflow-diff";
import { normalizeErrorSignature, scrubSecretShapes } from "@janusly/shared/src/error-signature";
import { WorkflowSchema } from "@janusly/shared";

import { auditAction } from "../audit-helper";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { getDeadLetter } from "../dlq";
import { asRecord, readJson, sendError, sendJson } from "../http";
import { recoverySuggestionSafety } from "../recovery-suggestion-safety";
import type { Route } from "../routes";

const CreatePlaybookBodySchema = z.object({
  deadLetterId: z.string().min(1).max(256),
  validationRunId: z.string().min(1).max(256),
  sourceWorkflowVersionId: z.string().min(1).max(256),
  title: z.string().trim().min(1).max(RECOVERY_PLAYBOOK_TITLE_MAX_CHARS),
  instructionsMarkdown: z.string().trim().min(1).max(RECOVERY_PLAYBOOK_INSTRUCTIONS_MAX_CHARS),
});

const UsePlaybookBodySchema = z.object({
  deadLetterId: z.string().min(1).max(256),
});

const OutcomeBodySchema = z.object({
  deadLetterId: z.string().min(1).max(256),
  validationRunId: z.string().min(1).max(256),
  phase: z.enum(["validation", "applied"]),
});

const ACTION_PATH = /^\/recovery\/playbooks\/([^/?]+)\/(use|activate|retire|outcome)$/;

function parseActionPath(rawUrl: string | undefined): { id: string; action: "use" | "activate" | "retire" | "outcome" } | null {
  const path = (rawUrl ?? "").split("?", 1)[0] ?? "";
  const match = ACTION_PATH.exec(path);
  if (!match?.[1] || !match[2]) return null;
  try {
    return {
      id: decodeURIComponent(match[1]),
      action: match[2] as "use" | "activate" | "retire" | "outcome",
    };
  } catch {
    return null;
  }
}

function workflowIdFromSnapshot(workflowJson: unknown): string | null {
  const id = (workflowJson as { id?: unknown } | null)?.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function normalizedSignature(deadLetter: {
  errorJson: unknown;
  nodeId: string;
  nodeJson: unknown;
}): string {
  const node = deadLetter.nodeJson as { type?: unknown; config?: { tool?: unknown } } | null;
  return normalizeErrorSignature(deadLetter.errorJson, {
    nodeId: deadLetter.nodeId,
    nodeType: typeof node?.type === "string" ? node.type : undefined,
    toolName: typeof node?.config?.tool === "string" ? node.config.tool : undefined,
  }).signature;
}

function publicPlaybook(playbook: RecoveryPlaybook) {
  return {
    id: playbook.id,
    workflowId: playbook.workflowId,
    signature: playbook.signature,
    version: playbook.version,
    status: playbook.status,
    title: playbook.title,
    instructionsMarkdown: playbook.instructionsMarkdown,
    approachLabel: playbook.approachLabel,
    successfulUses: playbook.successfulUses,
    regressions: playbook.regressions,
    lastValidatedAt: playbook.lastValidatedAt,
    activatedAt: playbook.activatedAt,
    retiredAt: playbook.retiredAt,
    createdAt: playbook.createdAt,
    updatedAt: playbook.updatedAt,
  };
}

async function resolveMatch(orgId: string, deadLetterId: string) {
  const deadLetter = await getDeadLetter(orgId, deadLetterId);
  if (!deadLetter) return { kind: "not_found" as const };
  const workflowId = workflowIdFromSnapshot(deadLetter.workflowJson);
  if (!workflowId) return { kind: "unsaved" as const };
  const signature = normalizedSignature(deadLetter);
  const playbook = await findMatchingActiveRecoveryPlaybook(orgId, workflowId, signature);
  return { kind: "ok" as const, deadLetter, workflowId, signature, playbook };
}

function validationWorkflow(run: { inputJson: unknown }): unknown {
  return (run.inputJson as { workflow?: unknown } | null)?.workflow;
}

function validationPlaybookId(run: { inputJson: unknown }): string | null {
  const value = (run.inputJson as { recoveryPlaybookId?: unknown } | null)?.recoveryPlaybookId;
  return typeof value === "string" ? value : null;
}

export const recoveryPlaybooksRoutes: Route[] = [
  {
    method: "GET",
    match: (url) => url === "/recovery/playbooks/match" || url.startsWith("/recovery/playbooks/match?"),
    role: "viewer",
    permission: "recovery.read",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const deadLetterId = url.searchParams.get("deadLetterId");
      if (!deadLetterId) return sendError(res, "dlq_field_required", "deadLetterId is required", 400, { field: "deadLetterId" });
      const match = await resolveMatch(auth.orgId, deadLetterId);
      if (match.kind === "not_found") return sendError(res, "dlq_not_found", "DLQ entry not found", 404);
      if (match.kind === "unsaved") return sendJson(res, { playbook: null });
      return sendJson(res, { playbook: match.playbook ? publicPlaybook(match.playbook) : null });
    },
  },
  {
    method: "POST",
    match: "/recovery/playbooks",
    role: "editor",
    permission: "recovery.write",
    handler: async ({ req, res, auth }) => {
      const parsed = CreatePlaybookBodySchema.safeParse(asRecord(await readJson(req, MAX_JSON_BODY_BYTES)));
      if (!parsed.success) return sendError(res, "recovery_playbook_invalid_body", "Invalid Recovery Playbook body", 400);

      const evidence = await resolveRecoveryPlaybookPromotionEvidence({
        orgId: auth.orgId,
        deadLetterId: parsed.data.deadLetterId,
        validationRunId: parsed.data.validationRunId,
        sourceWorkflowVersionId: parsed.data.sourceWorkflowVersionId,
      });
      if (!evidence.deadLetter) return sendError(res, "dlq_not_found", "DLQ entry not found", 404);
      const workflowId = workflowIdFromSnapshot(evidence.deadLetter.workflowJson);
      if (!workflowId || !evidence.sourceVersion || evidence.sourceVersion.workflowId !== workflowId) {
        return sendError(res, "recovery_playbook_source_mismatch", "The saved workflow version does not match this recovery", 422);
      }
      const validation = evidence.validationRun;
      if (
        !validation
        || validation.replayMode !== "validation"
        || validation.parentRunId !== evidence.deadLetter.runId
        || validation.status !== "succeeded"
        || !validation.createdAt
      ) {
        return sendError(res, "recovery_playbook_validation_required", "A successful sandbox validation is required", 422);
      }
      if (
        !evidence.sourceVersion.createdAt
        || evidence.sourceVersion.createdAt < validation.createdAt
      ) {
        return sendError(res, "recovery_playbook_source_mismatch", "The saved workflow version predates validation", 422);
      }
      if (
        evidence.deadLetter.status !== "replayed"
        || !evidence.deadLetter.replayedAt
        || evidence.deadLetter.replayedAt < evidence.sourceVersion.createdAt
      ) {
        return sendError(res, "recovery_playbook_apply_required", "The recovery must be applied after validation", 422);
      }
      const validatedWorkflow = WorkflowSchema.safeParse(validationWorkflow(validation));
      const sourceWorkflow = WorkflowSchema.safeParse(evidence.sourceVersion.dagJson);
      if (
        !validatedWorkflow.success
        || !sourceWorkflow.success
        || computeWorkflowDiff(validatedWorkflow.data, sourceWorkflow.data).summary.totalChanges !== 0
      ) {
        return sendError(res, "recovery_playbook_source_mismatch", "The saved workflow version is not the validated snapshot", 422);
      }
      if (
        !evidence.acceptedFeedback
        || evidence.acceptedFeedback.workflowId !== workflowId
        || !evidence.acceptedFeedback.createdAt
        || evidence.acceptedFeedback.createdAt < evidence.deadLetter.replayedAt
      ) {
        return sendError(res, "recovery_playbook_acceptance_required", "Accepted recovery feedback is required", 422);
      }
      const failedWorkflow = WorkflowSchema.safeParse(evidence.deadLetter.workflowJson);
      const sourceDiff = failedWorkflow.success
        ? computeWorkflowDiff(failedWorkflow.data, sourceWorkflow.data)
        : null;
      if (!sourceDiff || sourceDiff.summary.totalChanges <= 0) {
        return sendError(res, "recovery_playbook_evidence_required", "Non-empty patch evidence is required", 422);
      }

      const signature = normalizedSignature(evidence.deadLetter);
      const result = await createRecoveryPlaybookDraft({
        orgId: auth.orgId,
        workflowId,
        signature,
        title: scrubSecretShapes(parsed.data.title),
        instructionsMarkdown: scrubSecretShapes(parsed.data.instructionsMarkdown),
        sourceWorkflowVersionId: evidence.sourceVersion.id,
        approachLabel: evidence.acceptedFeedback.approachLabel,
        validationRunId: validation.id,
        actor: auth.userId,
        evidenceRequirementsJson: {
          requiredOnEveryUse: ["sandbox_validation", "explicit_production_apply"],
          sourceEvidence: {
            deadLetterId: evidence.deadLetter.id,
            validationRunId: validation.id,
            sourceWorkflowVersionId: evidence.sourceVersion.id,
            acceptedFeedbackId: evidence.acceptedFeedback.id,
            patchChangeCount: sourceDiff.summary.totalChanges,
          },
        },
      });
      if (result.created) {
        await auditAction(auth, "recovery.playbook.created", {
          targetType: "recovery_playbook",
          targetId: result.playbook.id,
          metadata: {
            deadLetterId: evidence.deadLetter.id,
            workflowId,
            signature,
            version: result.playbook.version,
            validationRunId: validation.id,
            sourceWorkflowVersionId: evidence.sourceVersion.id,
            patchChangeCount: sourceDiff.summary.totalChanges,
          },
        });
      }
      return sendJson(res, { playbook: publicPlaybook(result.playbook), created: result.created }, result.created ? 201 : 200);
    },
  },
  {
    method: "POST",
    match: (url) => ACTION_PATH.test(url.split("?", 1)[0] ?? ""),
    role: "editor",
    permission: "recovery.write",
    handler: async ({ req, res, auth }) => {
      const path = parseActionPath(req.url);
      if (!path) return sendError(res, "recovery_playbook_not_found", "Recovery Playbook not found", 404);

      if (path.action === "activate" || path.action === "retire") {
        const result = path.action === "activate"
          ? await activateRecoveryPlaybook(auth.orgId, path.id, auth.userId)
          : await retireRecoveryPlaybook(auth.orgId, path.id, auth.userId);
        if (result.kind === "not_found") return sendError(res, "recovery_playbook_not_found", "Recovery Playbook not found", 404);
        if (result.kind === "invalid_status" || result.kind === "conflict") {
          return sendError(res, "recovery_playbook_invalid_status", "Recovery Playbook cannot transition from its current status", 409);
        }
        await auditAction(auth, path.action === "activate" ? "recovery.playbook.activated" : "recovery.playbook.retired", {
          targetType: "recovery_playbook",
          targetId: result.playbook.id,
          metadata: { version: result.playbook.version, signature: result.playbook.signature },
        });
        return sendJson(res, { playbook: publicPlaybook(result.playbook) });
      }

      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      if (path.action === "use") {
        const parsed = UsePlaybookBodySchema.safeParse(body);
        if (!parsed.success) return sendError(res, "recovery_playbook_invalid_body", "Invalid Recovery Playbook body", 400);
        const match = await resolveMatch(auth.orgId, parsed.data.deadLetterId);
        if (match.kind === "not_found") return sendError(res, "dlq_not_found", "DLQ entry not found", 404);
        if (match.kind !== "ok" || !match.playbook || match.playbook.id !== path.id) {
          return sendError(res, "recovery_playbook_match_changed", "This playbook no longer matches the failure", 409);
        }
        const sourceWorkflow = WorkflowSchema.safeParse(match.playbook.sourceWorkflow);
        if (!sourceWorkflow.success) {
          return sendError(res, "recovery_playbook_source_invalid", "Recovery Playbook source workflow is invalid", 422);
        }
        await auditAction(auth, "recovery.playbook.used", {
          targetType: "recovery_playbook",
          targetId: match.playbook.id,
          metadata: {
            deadLetterId: parsed.data.deadLetterId,
            workflowId: match.workflowId,
            signature: match.signature,
            version: match.playbook.version,
          },
        });
        const suggestion = {
          mode: "playbook" as const,
          suggestedWorkflow: sourceWorkflow.data,
          rationale: match.playbook.instructionsMarkdown,
          suggestions: [{
            workflow: sourceWorkflow.data,
            rationale: match.playbook.instructionsMarkdown,
            approachLabel: match.playbook.approachLabel,
            confidence: 100,
            calibratedConfidence: 100,
            safety: recoverySuggestionSafety(sourceWorkflow.data, match.deadLetter.nodeId),
            consideredAlternatives: [],
          }],
          evidence: [{
            kind: "recovery_playbook" as const,
            sourceRef: match.playbook.id,
            label: match.playbook.title,
            snippet: `Version ${match.playbook.version}; ${match.playbook.successfulUses} successful uses; last validated ${match.playbook.lastValidatedAt?.toISOString() ?? "unknown"}.`,
            weight: 1,
          }],
          recoveryPassport: {
            failureSignature: match.signature,
            priorSameSignatureOutcome: null,
          },
          playbook: publicPlaybook(match.playbook),
        };
        return sendJson(res, { suggestion });
      }

      const parsed = OutcomeBodySchema.safeParse(body);
      if (!parsed.success) return sendError(res, "recovery_playbook_invalid_body", "Invalid Recovery Playbook body", 400);
      const facts = await resolveRecoveryPlaybookOutcomeFacts({
        orgId: auth.orgId,
        playbookId: path.id,
        deadLetterId: parsed.data.deadLetterId,
        validationRunId: parsed.data.validationRunId,
      });
      if (!facts.playbook) return sendError(res, "recovery_playbook_not_found", "Recovery Playbook not found", 404);
      if (!facts.deadLetter || !facts.validationRun) {
        return sendError(res, "recovery_playbook_outcome_invalid", "Recovery Playbook outcome cannot be verified", 422);
      }
      const run = facts.validationRun;
      if (
        run.replayMode !== "validation"
        || run.parentRunId !== facts.deadLetter.runId
        || validationPlaybookId(run) !== path.id
        || !["succeeded", "failed", "cancelled"].includes(run.status)
      ) {
        return sendError(res, "recovery_playbook_outcome_invalid", "Recovery Playbook outcome cannot be verified", 422);
      }

      const succeeded = run.status === "succeeded";
      const validationOutcome = await recordRecoveryPlaybookValidationOutcome({
        orgId: auth.orgId,
        id: path.id,
        validationRunId: run.id,
        succeeded,
        actor: auth.userId,
      });
      if (validationOutcome.recorded) {
        await auditAction(auth, succeeded ? "recovery.playbook.validated" : "recovery.playbook.regressed", {
          targetType: "recovery_playbook",
          targetId: path.id,
          metadata: { deadLetterId: facts.deadLetter.id, validationRunId: run.id, status: run.status },
        });
      }
      if (parsed.data.phase === "validation") {
        return sendJson(res, {
          playbook: validationOutcome.playbook ? publicPlaybook(validationOutcome.playbook) : null,
          recorded: validationOutcome.recorded,
        });
      }
      if (!succeeded || !facts.impactEvent) {
        return sendError(res, "recovery_playbook_apply_required", "A passed sandbox and terminally successful recovery are required", 422);
      }
      const applied = await recordRecoveryPlaybookApplied({
        orgId: auth.orgId,
        id: path.id,
        validationRunId: run.id,
        actor: auth.userId,
      });
      if (applied.recorded) {
        await auditAction(auth, "recovery.playbook.applied", {
          targetType: "recovery_playbook",
          targetId: path.id,
          metadata: { deadLetterId: facts.deadLetter.id, validationRunId: run.id },
        });
      }
      return sendJson(res, { playbook: applied.playbook ? publicPlaybook(applied.playbook) : null, recorded: applied.recorded });
    },
  },
];

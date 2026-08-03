import {
  claimApplyPublication,
  claimApplyPublicationRetry,
  completeApplyPublication,
  countRecentAttemptsBySignature,
  getByIdForOrg,
  getOrgConfigSnapshot,
  listDueApplyPublications,
  recordApplyPublicationFailure,
  recordApplyTerminalFailure,
  type AutoHealingAutonomyContext,
  type AutoHealingRun,
} from "@janusly/data";
import { DLQReplayAdapter } from "@janusly/engine/src/adapters/dlq-replay";
import { WorkflowSchema, type Workflow, type WorkflowNode } from "@janusly/shared";
import { scrubSecretShapes } from "@janusly/shared/src/error-signature";

import { assessAutoHealingAutonomyRow } from "./auto-healing-autonomy";
import {
  isAutoApplyAllowed,
  isAutoHealingAllowed,
} from "./auto-healing-consent";
import { getDeadLetter, markDeadLetterReplayed } from "./dlq";

const replayAdapter = new DLQReplayAdapter();

type PreparedApply = {
  row: AutoHealingRun;
  workflow: Workflow;
  node: WorkflowNode;
  runId: string;
  autonomyContext: AutoHealingAutonomyContext;
};

export type AutoHealingApplyAuthority =
  | { kind: "operator"; actor: string }
  | { kind: "autonomous"; actor: "system:auto-healing" };

export type AutoHealingApplyResult =
  | { outcome: "applied"; row: AutoHealingRun; receipt: string }
  | { outcome: "pending"; row: AutoHealingRun; receipt: string }
  | {
      outcome: "rejected";
      code:
        | "not_found"
        | "not_pending"
        | "invalid_patch"
        | "missing_context"
        | "publication_conflict"
        | "autonomy_policy_blocked";
      row: AutoHealingRun | null;
    };

type PrepareResult =
  | { ok: true; value: PreparedApply }
  | {
      ok: false;
      code: "invalid_patch" | "missing_context" | "publication_conflict";
      message: string;
    };

/**
 * Claims and publishes one operator or system decision. A successful return
 * means the exact receipt is durable in Postgres; Redis delivery may still be
 * completed by the existing run-node publication reconciler.
 */
export async function applyValidatedAutoHealing(input: {
  orgId: string;
  id: string;
  authority: AutoHealingApplyAuthority;
}): Promise<AutoHealingApplyResult> {
  const row = await getByIdForOrg(input.orgId, input.id);
  if (!row) return { outcome: "rejected", code: "not_found", row: null };
  if (row.status !== "validated") {
    return { outcome: "rejected", code: "not_pending", row };
  }

  const prepared = await prepareApply(row);
  if (!prepared.ok) {
    return { outcome: "rejected", code: prepared.code, row };
  }

  if (input.authority.kind === "autonomous") {
    const authorized = await authorizeAutonomousApply(
      row,
      prepared.value.autonomyContext,
    );
    if (!authorized) {
      return {
        outcome: "rejected",
        code: "autonomy_policy_blocked",
        row,
      };
    }
  }

  const claim = await claimApplyPublication(
    input.orgId,
    input.id,
    input.authority.actor,
  );
  if (!claim.claimed) {
    return { outcome: "rejected", code: "not_pending", row };
  }
  return publishClaim(
    prepared.value,
    claim.receipt,
    input.authority.actor,
  );
}

/**
 * Repairs expired publication leases across tenants. Every row is leased with
 * a CAS update before replay work starts, so concurrent API replicas converge
 * on the same stable receipt without creating duplicate effects.
 */
export async function repairAutoHealingPublications(): Promise<{
  scanned: number;
  applied: number;
  pending: number;
  failed: number;
}> {
  const due = await listDueApplyPublications();
  const summary = { scanned: due.length, applied: 0, pending: 0, failed: 0 };
  for (const candidate of due) {
    try {
      const receipt = await claimApplyPublicationRetry(candidate.orgId, candidate.id);
      if (!receipt) continue;
      const row = await getByIdForOrg(candidate.orgId, candidate.id);
      if (!row) continue;
      const prepared = await prepareApply(row, receipt);
      if (!prepared.ok) {
        await recordApplyTerminalFailure(
          row.orgId,
          row.id,
          receipt,
          prepared.code === "publication_conflict"
            ? "signature_already_resolved"
            : "scanner_error",
          prepared.message,
        );
        summary.failed += 1;
        continue;
      }
      const result = await publishClaim(
        prepared.value,
        receipt,
        row.decisionActor ?? "system:auto-healing",
      );
      if (result.outcome === "applied") summary.applied += 1;
      else if (result.outcome === "pending") summary.pending += 1;
      else summary.failed += 1;
    } catch (error) {
      summary.failed += 1;
      console.error("[auto-healing] publication repair failed", {
        id: candidate.id,
        error: safeErrorMessage(error),
      });
    }
  }
  return summary;
}

async function prepareApply(
  row: AutoHealingRun,
  expectedReceipt?: string,
): Promise<PrepareResult> {
  const workflow = WorkflowSchema.safeParse(row.proposedPatchJson);
  if (!workflow.success) {
    return {
      ok: false,
      code: "invalid_patch",
      message: "Stored patch failed schema validation",
    };
  }
  const deadLetter = await getDeadLetter(row.orgId, row.deadLetterId);
  if (!deadLetter) {
    return {
      ok: false,
      code: "missing_context",
      message: "Dead letter no longer exists",
    };
  }
  if (!expectedReceipt && (
    deadLetter.status !== "open"
    || deadLetter.replayClaimToken
  )) {
    return {
      ok: false,
      code: "publication_conflict",
      message: "Dead letter is already owned by another recovery action",
    };
  }
  if (
    expectedReceipt
    && (
      (deadLetter.replayClaimToken && deadLetter.replayClaimToken !== expectedReceipt)
      || (!deadLetter.replayClaimToken && deadLetter.status !== "open")
    )
  ) {
    return {
      ok: false,
      code: "publication_conflict",
      message: "Dead letter was claimed by another recovery action",
    };
  }
  const node = (workflow.data.nodes as WorkflowNode[]).find(
    (candidate) => candidate.id === deadLetter.nodeId,
  );
  if (!node) {
    return {
      ok: false,
      code: "missing_context",
      message: "Failing node is absent from the patched workflow",
    };
  }
  return {
    ok: true,
    value: {
      row,
      workflow: workflow.data,
      node,
      runId: deadLetter.runId,
      autonomyContext: {
        deadLetterId: deadLetter.id,
        workflowJson: deadLetter.workflowJson,
        nodeId: deadLetter.nodeId,
        errorJson: deadLetter.errorJson,
      },
    },
  };
}

async function authorizeAutonomousApply(
  row: AutoHealingRun,
  context: AutoHealingAutonomyContext,
): Promise<boolean> {
  try {
    const [masterConsent, autoApplyConsent, snapshot] = await Promise.all([
      isAutoHealingAllowed(row.orgId),
      isAutoApplyAllowed(row.orgId),
      getOrgConfigSnapshot(row.orgId),
    ]);
    if (!masterConsent.allowed || !autoApplyConsent.allowed) return false;

    const attempts = await countRecentAttemptsBySignature(
      row.orgId,
      row.signature,
      snapshot.autoHealing.loopWindowDays,
    );
    if (attempts > snapshot.autoHealing.maxAttemptsPerSignature) {
      return false;
    }

    const assessment = await assessAutoHealingAutonomyRow(row, context);
    return assessment.eligible;
  } catch (error) {
    console.warn("[auto-healing] autonomous authorization failed closed", {
      id: row.id,
      error: safeErrorMessage(error),
    });
    return false;
  }
}

async function publishClaim(
  prepared: PreparedApply,
  receipt: string,
  actor: string,
): Promise<AutoHealingApplyResult> {
  const { row } = prepared;
  let durable = await hasDurableReceipt(row.orgId, row.deadLetterId, receipt);
  if (!durable) {
    try {
      await replayAdapter.replayDeadLetter({
        runId: prepared.runId,
        workflow: prepared.workflow,
        node: prepared.node,
        recoveryClaimToken: receipt,
        deadLetterId: row.deadLetterId,
        recoveryActorId: actor,
      });
    } catch (error) {
      durable = await hasDurableReceipt(row.orgId, row.deadLetterId, receipt);
      if (!durable) {
        await recordApplyPublicationFailure(
          row.orgId,
          row.id,
          receipt,
          safeErrorMessage(error),
        );
        return { outcome: "pending", row, receipt };
      }
    }
  }

  durable ||= await hasDurableReceipt(row.orgId, row.deadLetterId, receipt);
  if (!durable) {
    await recordApplyPublicationFailure(
      row.orgId,
      row.id,
      receipt,
      "Replay returned without a matching durable claim",
    );
    return { outcome: "pending", row, receipt };
  }

  try {
    const marked = await markDeadLetterReplayed(
      row.orgId,
      row.deadLetterId,
      receipt,
    );
    if (!marked) {
      await recordApplyTerminalFailure(
        row.orgId,
        row.id,
        receipt,
        "signature_already_resolved",
        "Dead letter changed after the replay claim was persisted",
      );
      return {
        outcome: "rejected",
        code: "publication_conflict",
        row,
      };
    }
  } catch (error) {
    await recordApplyPublicationFailure(
      row.orgId,
      row.id,
      receipt,
      safeErrorMessage(error),
    );
    return { outcome: "pending", row, receipt };
  }

  let completed: boolean;
  try {
    completed = await completeApplyPublication(row.orgId, row.id, receipt);
  } catch (error) {
    await recordApplyPublicationFailure(
      row.orgId,
      row.id,
      receipt,
      safeErrorMessage(error),
    );
    return { outcome: "pending", row, receipt };
  }
  if (!completed) {
    const current = await getByIdForOrg(row.orgId, row.id);
    if (
      current?.status !== "applied"
      || current.publicationReceipt !== receipt
    ) {
      return { outcome: "rejected", code: "publication_conflict", row: current };
    }
  }
  return { outcome: "applied", row, receipt };
}

async function hasDurableReceipt(
  orgId: string,
  deadLetterId: string,
  receipt: string,
): Promise<boolean> {
  const deadLetter = await getDeadLetter(orgId, deadLetterId);
  return deadLetter?.replayClaimToken === receipt && Boolean(deadLetter.replayClaimedAt);
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return scrubSecretShapes(error.message)
      .replace(/[\r\n]+/g, " ")
      .slice(0, 500);
  }
  return "Unknown publication failure";
}

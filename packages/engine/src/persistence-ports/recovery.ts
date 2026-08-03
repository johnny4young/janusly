/** Atomic semantic-outcome detection, containment, and resolution persistence. */

import { db, recoveryCases, recoveryCaseTransitions, runEvents, runNodes, runs } from "@janusly/db";
import { recordRecoveryImpactTx } from "@janusly/data";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  combineRecoveryAutonomyProfiles,
  RECOVERY_CASE_OPEN_STATES,
  resolveRecoveryAutonomyProfile,
  WorkflowSchema,
  type RecoveryAutonomyProfile,
  type Workflow,
} from "@janusly/shared";
import { createHash } from "node:crypto";
import { publishRunEvent } from "../run-event-stream";
import { safePersistPayload } from "../safe-persist";
import { evaluateSemanticOutcome, type SemanticOutcomeViolation } from "../semantic-outcomes";
import type { NodeCompletionOutcome, SemanticOutcomeViolationRecord } from "../core/types";
import {
  asPlainObject,
  ERROR_JSON_MAX_BYTES,
  projectRunContext,
  recoveryClaimPredicate,
  STATE_JSON_MAX_BYTES,
} from "./internal";

/**
 * Cap on how much of a node's output the `node.succeeded` EVENT payload
 * repeats. The full output (up to `STATE_JSON_MAX_BYTES`) always lands in the
 * node row's `state_json` — the event copy exists only so the live SSE stream
 * can preview it before the poll loop refetches node rows. Below the cap the
 * event carries the full output (live Inspector is byte-identical to a
 * refetch); above it the event carries just a byte count + a truncation flag,
 * so a 1 MB http body isn't written twice on the hottest completion path.
 */
const NODE_SUCCEEDED_EVENT_OUTPUT_MAX_BYTES = 8_000;

/** Best-effort JSON byte size; returns `Infinity` when the value can't be measured (treated as "large"). */
function approximateJsonBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? new TextEncoder().encode(json).length : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function stableSemanticId(
  prefix: "sem" | "sct",
  ...parts: string[]
): string {
  return `${prefix}_${createHash("sha256")
    .update(parts.join("\0"))
    .digest("hex")
    .slice(0, 32)}`;
}

/**
 * Complete a node and persist deterministic semantic violations atomically.
 *
 * Quarantine changes the run to `waiting` in the same transaction as node
 * success and case creation, closing the crash window where downstream work
 * could be published before the business-outcome gate became durable.
 */
export async function markNodeSucceededWithOutcome(
  runId: string,
  nodeId: string,
  output: unknown,
  attempt: number,
  violations: readonly SemanticOutcomeViolationRecord[],
  recoveryClaimToken?: string,
): Promise<NodeCompletionOutcome> {
  const finishedAt = new Date();
  const eventId = crypto.randomUUID();
  const stateJson = safePersistPayload({ output: output ?? {} }, { maxBytes: STATE_JSON_MAX_BYTES });
  const quarantined = violations.some(
    (violation) => violation.action === "quarantine",
  );
  const caseIds = violations.map((violation) =>
    stableSemanticId("sem", runId, violation.detectorId),
  );
  const semanticEvents = violations.map((violation, index) => {
    const id = crypto.randomUUID();
    const caseId = caseIds[index]!;
    return {
      id,
      caseId,
      violation,
      payload: safePersistPayload({
        caseId,
        detectorId: violation.detectorId,
        sourceNodeId: violation.sourceNodeId,
        kind: violation.kind,
        action: violation.action,
        message: violation.message,
        details: violation.details?.slice(0, 50),
      }),
    };
  });

  const outputBytes = approximateJsonBytes(output ?? {});
  const rawEventPayload = outputBytes <= NODE_SUCCEEDED_EVENT_OUTPUT_MAX_BYTES
    ? { output: output ?? {}, attempt }
    : { outputBytes, outputTruncated: true, attempt };
  // Still run the chokepoint for key-redaction (and as a size backstop).
  const eventPayload = safePersistPayload(rawEventPayload);

  const completed = await db.transaction(async (tx) => {
    const [completed] = await tx.update(runNodes)
      .set({ status: "succeeded", stateJson, finishedAt })
      .where(and(
        eq(runNodes.runId, runId),
        eq(runNodes.nodeId, nodeId),
        eq(runNodes.status, "running"),
        recoveryClaimPredicate(recoveryClaimToken),
      ))
      .returning({
        deadLetterId: runNodes.recoveryDeadLetterId,
        userId: runNodes.recoveryRequestedBy,
        playbookId: runNodes.recoveryPlaybookId,
        validationRunId: runNodes.recoveryValidationRunId,
      });
    if (!completed) return false;

    await tx.insert(runEvents).values({
      id: eventId,
      runId,
      nodeId,
      type: "node.succeeded",
      payload: eventPayload,
      createdAt: finishedAt,
    });

    if (violations.length > 0) {
      const [run] = await tx
        .select({
          orgId: runs.orgId,
          workflowVersionId: runs.workflowVersionId,
          inputJson: runs.inputJson,
          createdBy: runs.createdBy,
          status: runs.status,
        })
        .from(runs)
        .where(eq(runs.id, runId))
        .limit(1)
        .for("update");
      if (!run) {
        throw new Error(
          `Run ${runId} disappeared during semantic outcome persistence`,
        );
      }
      const workflow = asPlainObject(
        asPlainObject(run.inputJson)?.workflow,
      );
      const workflowId =
        typeof workflow?.id === "string" ? workflow.id : null;
      await tx
        .insert(recoveryCases)
        .values(
          violations.map((violation, index) => ({
            id: caseIds[index]!,
            orgId: run.orgId,
            runId,
            workflowId,
            workflowVersionId: run.workflowVersionId,
            source: "semantic_violation" as const,
            detectorId: violation.detectorId,
            sourceNodeId: violation.sourceNodeId,
            detectorKind: violation.kind,
            action: violation.action,
            message: violation.message,
            detailsJson: safePersistPayload(
              violation.details?.slice(0, 50) ?? null,
              { maxBytes: ERROR_JSON_MAX_BYTES },
            ),
            state:
              violation.action === "quarantine"
                ? "contained"
                : "detected",
            createdBy: run.createdBy,
            createdAt: finishedAt,
            updatedAt: finishedAt,
          })),
        )
        .onConflictDoNothing();

      const contained = violations
        .map((violation, index) => ({ violation, index }))
        .filter(
          ({ violation }) => violation.action === "quarantine",
        );
      if (contained.length > 0) {
        await tx
          .insert(recoveryCaseTransitions)
          .values(
            contained.map(({ violation, index }) => {
              const caseId = caseIds[index]!;
              return {
                id: stableSemanticId("sct", caseId, "contained"),
                orgId: run.orgId,
                caseId,
                fromState: "detected",
                toState: "contained",
                actorKind: "system" as const,
                evidenceJson: [
                  { kind: "run_node", id: `${runId}:${nodeId}` },
                  {
                    kind: "semantic_detector",
                    id: violation.detectorId,
                  },
                ],
                reason: violation.message,
                occurredAt: finishedAt,
              };
            }),
          )
          .onConflictDoNothing();
      }

      await tx.insert(runEvents).values(
        semanticEvents.map((event) => ({
          id: event.id,
          runId,
          nodeId,
          type: "recovery.semantic_violation",
          payload: event.payload,
          createdAt: finishedAt,
        })),
      );
      const semanticCasesForRun = await tx
        .select({
          action: recoveryCases.action,
          state: recoveryCases.state,
        })
        .from(recoveryCases)
        .where(
          and(
            eq(recoveryCases.orgId, run.orgId),
            eq(recoveryCases.runId, runId),
          ),
        );
      const hasOpenQuarantine = semanticCasesForRun.some(
        (item) =>
          item.action === "quarantine" &&
          RECOVERY_CASE_OPEN_STATES.some(
            (state) => state === item.state,
          ),
      );
      const outcomeStatus = hasOpenQuarantine
        ? "semantic_quarantined" as const
        : "semantic_violation" as const;
      const projectedStatus = hasOpenQuarantine
        ? "waiting"
        : run.status;
      await tx
        .update(runs)
        .set({
          ...(hasOpenQuarantine ? { status: "waiting" } : {}),
          outcomeStatus,
          semanticViolationCount: semanticCasesForRun.length,
        })
        .where(eq(runs.id, runId));
      return {
        projection: {
          status: projectedStatus,
          outcomeStatus,
          semanticViolationCount: semanticCasesForRun.length,
        },
      };
    } else {
      await recordRecoveryImpactTx(tx, {
        deadLetterId: completed?.deadLetterId ?? null,
        userId: completed?.userId ?? null,
        playbookId: completed?.playbookId ?? null,
        validationRunId: completed?.validationRunId ?? null,
        runId,
        nodeId,
        recoveredAt: finishedAt,
      });
    }
    return { projection: null };
  });

  if (!completed) {
    return { completed: false, quarantined: false, caseIds: [] };
  }

  publishRunEvent(runId, {
    kind: "event",
    id: eventId,
    nodeId,
    type: "node.succeeded",
    payload: eventPayload,
    createdAt: finishedAt.toISOString(),
  });
  for (const event of semanticEvents) {
    publishRunEvent(runId, {
      kind: "event",
      id: event.id,
      nodeId,
      type: "recovery.semantic_violation",
      payload: event.payload,
      createdAt: finishedAt.toISOString(),
    });
  }
  if (completed.projection) {
    publishRunEvent(runId, {
      kind: "run.status",
      ...completed.projection,
    });
  }
  return { completed: true, quarantined, caseIds };
}

export type ResolveSemanticOutcomeCaseResult =
  | {
      status: "resolved";
      runId: string;
      sourceNodeId: string;
      decision: "replace" | "accept_loss";
      resumed: boolean;
      workflow: Workflow;
      resolvedCaseIds: string[];
    }
  | { status: "not_found" }
  | { status: "conflict"; reason: string }
  | {
      status: "policy_blocked";
      profile: RecoveryAutonomyProfile;
    }
  | {
      status: "invalid_output";
      violations: SemanticOutcomeViolation[];
    };

const SEMANTIC_RECOVERY_STATES = [
  "diagnosed",
  "candidates_ready",
  "validating",
  "awaiting_approval",
  "publishing",
  "monitoring",
  "verified_recovered",
] as const;

/**
 * Resolve a quarantined semantic outcome through an explicit operator
 * decision. Replacement output is re-evaluated against a locked run snapshot
 * before any mutation; accepted loss retains the original output and records
 * that choice.
 */
export async function resolveSemanticOutcomeCase(input: {
  orgId: string;
  caseId: string;
  actorId: string;
  decision: "replace" | "accept_loss";
  output?: unknown;
  reason: string;
}): Promise<ResolveSemanticOutcomeCaseResult> {
  const [snapshot] = await db
    .select({
      case: recoveryCases,
      runStatus: runs.status,
      runInputJson: runs.inputJson,
    })
    .from(recoveryCases)
    .innerJoin(runs, eq(runs.id, recoveryCases.runId))
    .where(
      and(
        eq(recoveryCases.orgId, input.orgId),
        eq(recoveryCases.id, input.caseId),
        eq(runs.orgId, input.orgId),
      ),
    )
    .limit(1);
  if (!snapshot) return { status: "not_found" };
  const resolvesQuarantine =
    snapshot.case.action === "quarantine" &&
    snapshot.case.state === "contained" &&
    snapshot.runStatus === "waiting";
  const acknowledgesObservation =
    snapshot.case.action === "observe" &&
    snapshot.case.state === "detected" &&
    input.decision === "accept_loss";
  if (
    snapshot.case.source !== "semantic_violation" ||
    (!resolvesQuarantine && !acknowledgesObservation)
  ) {
    return {
      status: "conflict",
      reason: "Recovery case is not an active semantic quarantine",
    };
  }

  const rawInput = asPlainObject(snapshot.runInputJson);
  const workflow = WorkflowSchema.parse(rawInput?.workflow);
  const contract = workflow.recovery?.contract;
  if (contract?.version !== "2") {
    return {
      status: "conflict",
      reason: "Run snapshot has no deterministic semantic contract",
    };
  }

  const occurredAt = new Date();
  const eventId = crypto.randomUUID();
  const resolved = await db.transaction(async (tx) => {
    // Node completion owns a node row before it may lock the run row. Locking
    // every node in stable order first preserves that ordering and freezes the
    // cross-node context used by deterministic expression detectors.
    const lockedNodes = await tx
      .select({
        nodeId: runNodes.nodeId,
        status: runNodes.status,
        attempts: runNodes.attempts,
        stateJson: runNodes.stateJson,
        errorJson: runNodes.errorJson,
      })
      .from(runNodes)
      .where(eq(runNodes.runId, snapshot.case.runId))
      .orderBy(runNodes.id)
      .for("update");
    const [lockedRun] = await tx
      .select({
        status: runs.status,
        semanticViolationCount: runs.semanticViolationCount,
      })
      .from(runs)
      .where(
        and(
          eq(runs.id, snapshot.case.runId),
          eq(runs.orgId, input.orgId),
        ),
      )
      .limit(1)
      .for("update");
    if (!lockedRun) return null;
    if (
      snapshot.case.action === "quarantine" &&
      lockedRun.status !== "waiting"
    ) {
      return null;
    }

    const openCases = await tx
      .select()
      .from(recoveryCases)
      .where(
        and(
          eq(recoveryCases.orgId, input.orgId),
          eq(recoveryCases.runId, snapshot.case.runId),
          eq(
            recoveryCases.sourceNodeId,
            snapshot.case.sourceNodeId,
          ),
          inArray(recoveryCases.state, ["detected", "contained"]),
        ),
      )
      .for("update");
    if (
      openCases.length === 0 ||
      !openCases.some((item) => item.id === input.caseId)
    ) {
      return null;
    }

    if (input.decision === "replace") {
      const autonomy = combineRecoveryAutonomyProfiles(
        openCases.map((item) =>
          resolveRecoveryAutonomyProfile(contract, {
            kind: "semantic",
            detectorId: item.detectorId,
          }),
        ),
      );
      if (!autonomy.capabilities.applyWithApproval) {
        return {
          kind: "policy_blocked" as const,
          profile: autonomy,
        };
      }
      const evaluation = evaluateSemanticOutcome({
        contract,
        sourceNodeId: snapshot.case.sourceNodeId,
        output: input.output,
        context: projectRunContext(lockedNodes),
      });
      if (
        evaluation.evaluated === 0 ||
        evaluation.violations.length > 0
      ) {
        return {
          kind: "invalid_output" as const,
          violations: evaluation.violations,
        };
      }
    }

    const finalState =
      input.decision === "replace"
        ? "verified_recovered"
        : "accepted_loss";
    const updated = await tx
      .update(recoveryCases)
      .set({
        state: finalState,
        updatedAt: occurredAt,
        resolvedAt: occurredAt,
      })
      .where(
        and(
          inArray(
            recoveryCases.id,
            openCases.map((item) => item.id),
          ),
          inArray(recoveryCases.state, ["detected", "contained"]),
        ),
      )
      .returning({ id: recoveryCases.id });
    if (updated.length !== openCases.length) return null;

    if (input.decision === "replace") {
      const nodeState = safePersistPayload(
        { output: input.output },
        { maxBytes: STATE_JSON_MAX_BYTES },
      );
      const [changed] = await tx
        .update(runNodes)
        .set({ stateJson: nodeState })
        .where(
          and(
            eq(runNodes.runId, snapshot.case.runId),
            eq(runNodes.nodeId, snapshot.case.sourceNodeId),
            eq(runNodes.status, "succeeded"),
          ),
        )
        .returning({
          id: runNodes.id,
          deadLetterId: runNodes.recoveryDeadLetterId,
          userId: runNodes.recoveryRequestedBy,
          playbookId: runNodes.recoveryPlaybookId,
          validationRunId: runNodes.recoveryValidationRunId,
        });
      if (!changed) return null;
      await recordRecoveryImpactTx(tx, {
        deadLetterId: changed.deadLetterId,
        userId: changed.userId,
        playbookId: changed.playbookId,
        validationRunId: changed.validationRunId,
        runId: snapshot.case.runId,
        nodeId: snapshot.case.sourceNodeId,
        recoveredAt: occurredAt,
      });
    }

    const receipts = openCases.flatMap((item) => {
      if (input.decision === "accept_loss") {
        return [
          {
            id: stableSemanticId(
              "sct",
              item.id,
              "accepted_loss",
            ),
            orgId: input.orgId,
            caseId: item.id,
            fromState: item.state,
            toState: "accepted_loss",
            actorKind: "user" as const,
            actorId: input.actorId,
            evidenceJson: [
              {
                kind: "operator_decision",
                id: eventId,
              },
              {
                kind: "run_node",
                id: `${snapshot.case.runId}:${snapshot.case.sourceNodeId}`,
              },
            ],
            reason: input.reason,
            occurredAt,
          },
        ];
      }

      let fromState = item.state;
      const targetStates = [
        ...(item.state === "detected"
          ? (["contained"] as const)
          : []),
        ...SEMANTIC_RECOVERY_STATES,
      ];
      return targetStates.map((toState, index) => {
        const receipt = {
          id: stableSemanticId("sct", item.id, toState),
          orgId: input.orgId,
          caseId: item.id,
          fromState,
          toState,
          actorKind: "user" as const,
          actorId: input.actorId,
          evidenceJson: [
            {
              kind: "operator_decision",
              id: eventId,
            },
            {
              kind: "run_node",
              id: `${snapshot.case.runId}:${snapshot.case.sourceNodeId}`,
            },
            {
              kind: "semantic_detector",
              id: item.detectorId,
            },
          ],
          reason:
            index === targetStates.length - 1
              ? "Replacement output passed every deterministic detector"
              : input.reason,
          occurredAt: new Date(occurredAt.getTime() + index),
        };
        fromState = toState;
        return receipt;
      });
    });
    await tx
      .insert(recoveryCaseTransitions)
      .values(receipts)
      .onConflictDoNothing();

    const remainingCases = await tx
      .select({
        action: recoveryCases.action,
        state: recoveryCases.state,
      })
      .from(recoveryCases)
      .where(
        and(
          eq(recoveryCases.orgId, input.orgId),
          eq(recoveryCases.runId, snapshot.case.runId),
          inArray(
            recoveryCases.state,
            [...RECOVERY_CASE_OPEN_STATES],
          ),
        ),
      );
    const hasRemainingQuarantine = remainingCases.some(
      (item) => item.action === "quarantine",
    );
    const resumed =
      lockedRun.status === "waiting" && !hasRemainingQuarantine;
    const outcomeStatus = hasRemainingQuarantine
      ? "semantic_quarantined"
      : remainingCases.length > 0
        ? "semantic_violation"
        : input.decision === "replace"
          ? "semantic_recovered"
          : "semantic_accepted_loss";
    const [updatedRun] = await tx
      .update(runs)
      .set({
        ...(resumed ? { status: "running" } : {}),
        outcomeStatus,
      })
      .where(
        and(
          eq(runs.id, snapshot.case.runId),
          eq(runs.orgId, input.orgId),
          eq(runs.status, lockedRun.status),
        ),
      )
      .returning({ id: runs.id });
    if (!updatedRun) return null;
    if (resumed) {
      await tx
        .update(runNodes)
        .set({ queuePublicationRepairAfter: occurredAt })
        .where(
          and(
            eq(runNodes.runId, snapshot.case.runId),
            eq(runNodes.status, "pending"),
            isNull(runNodes.queuePublicationRepairAfter),
          ),
        );
    }

    const payload = safePersistPayload({
      caseIds: openCases.map((item) => item.id),
      sourceNodeId: snapshot.case.sourceNodeId,
      decision: input.decision,
      resumed,
      reason: input.reason,
    });
    await tx.insert(runEvents).values({
      id: eventId,
      runId: snapshot.case.runId,
      nodeId: snapshot.case.sourceNodeId,
      type: "recovery.semantic_resolved",
      payload,
      createdAt: occurredAt,
    });

    return {
      kind: "resolved" as const,
      ids: openCases.map((item) => item.id),
      payload,
      resumed,
      runStatus: resumed ? "running" : lockedRun.status,
      outcomeStatus,
      semanticViolationCount: lockedRun.semanticViolationCount,
    };
  });

  if (resolved?.kind === "invalid_output") {
    return {
      status: "invalid_output",
      violations: resolved.violations,
    };
  }
  if (resolved?.kind === "policy_blocked") {
    return {
      status: "policy_blocked",
      profile: resolved.profile,
    };
  }
  if (!resolved) {
    return {
      status: "conflict",
      reason: "Recovery case changed while it was being resolved",
    };
  }

  publishRunEvent(snapshot.case.runId, {
    kind: "event",
    id: eventId,
    nodeId: snapshot.case.sourceNodeId,
    type: "recovery.semantic_resolved",
    payload: resolved.payload,
    createdAt: occurredAt.toISOString(),
  });
  publishRunEvent(snapshot.case.runId, {
    kind: "run.status",
    status: resolved.runStatus,
    outcomeStatus: resolved.outcomeStatus,
    semanticViolationCount: resolved.semanticViolationCount,
  });

  return {
    status: "resolved",
    runId: snapshot.case.runId,
    sourceNodeId: snapshot.case.sourceNodeId,
    decision: input.decision,
    resumed: resolved.resumed,
    workflow,
    resolvedCaseIds: resolved.ids,
  };
}

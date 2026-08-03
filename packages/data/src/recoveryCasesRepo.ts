/**
 * Tenant-scoped read model for durable Recovery Cases.
 *
 * Runtime writes live beside the atomic run/node transitions in
 * `packages/engine/src/persistence-ports/recovery.ts`; this repository owns
 * bounded reads for API and UI consumers. Cases are orphan-tolerant forensic
 * records and never rely on a join to a still-existing run or workflow.
 */

import {
  db,
  recoveryCases,
  recoveryCaseTransitions,
  runs,
  workflowVersions,
} from "@janusly/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  combineRecoveryAutonomyProfiles,
  RECOVERY_CASE_OPEN_STATES,
  RECOVERY_CASE_TERMINAL_STATES,
  resolveRecoveryAutonomyProfile,
  WorkflowSchema,
  type RecoveryAutonomyProfile,
} from "@janusly/shared";

export type RecoveryCase = typeof recoveryCases.$inferSelect;
export type RecoveryCaseTransition =
  typeof recoveryCaseTransitions.$inferSelect;

export async function listRecoveryCases(
  orgId: string,
  options: {
    openOnly?: boolean;
    runId?: string;
    limit?: number;
  } = {},
): Promise<RecoveryCase[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
  const filters = [eq(recoveryCases.orgId, orgId)];
  if (options.openOnly !== false) {
    filters.push(
      inArray(recoveryCases.state, [...RECOVERY_CASE_OPEN_STATES]),
    );
  }
  if (options.runId) {
    filters.push(eq(recoveryCases.runId, options.runId));
  }

  return db
    .select()
    .from(recoveryCases)
    .where(and(...filters))
    .orderBy(desc(recoveryCases.createdAt), desc(recoveryCases.id))
    .limit(limit);
}

export async function getRecoveryCase(
  orgId: string,
  caseId: string,
): Promise<RecoveryCase | null> {
  const [row] = await db
    .select()
    .from(recoveryCases)
    .where(
      and(
        eq(recoveryCases.orgId, orgId),
        eq(recoveryCases.id, caseId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listRecoveryCaseTransitions(
  orgId: string,
  caseId: string,
): Promise<RecoveryCaseTransition[]> {
  return db
    .select()
    .from(recoveryCaseTransitions)
    .where(
      and(
        eq(recoveryCaseTransitions.orgId, orgId),
        eq(recoveryCaseTransitions.caseId, caseId),
      ),
    )
    .orderBy(
      recoveryCaseTransitions.occurredAt,
      recoveryCaseTransitions.id,
    )
    .limit(100);
}

function workflowFromRunInput(input: unknown): unknown {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input)
  ) {
    return null;
  }
  return (input as { workflow?: unknown }).workflow ?? null;
}

/**
 * Resolve the effective policy for every detector that shares the case's
 * source node. A single replacement closes that cohort atomically, so the
 * strictest detector must govern the decision even after the cohort becomes
 * terminal.
 *
 * Saved workflows resolve through their immutable version. Ad-hoc runs fall
 * back to the run-start workflow snapshot; both reads remain tenant-scoped.
 */
export async function resolveRecoveryCaseAutonomyProfile(
  orgId: string,
  recoveryCase: RecoveryCase,
): Promise<RecoveryAutonomyProfile> {
  const [versionRows, runRows, peerCases] = await Promise.all([
    db
      .select({ dagJson: workflowVersions.dagJson })
      .from(workflowVersions)
      .where(
        and(
          eq(workflowVersions.orgId, orgId),
          eq(workflowVersions.id, recoveryCase.workflowVersionId),
        ),
      )
      .limit(1),
    db
      .select({ inputJson: runs.inputJson })
      .from(runs)
      .where(
        and(
          eq(runs.orgId, orgId),
          eq(runs.id, recoveryCase.runId),
        ),
      )
      .limit(1),
    db
      .select({ detectorId: recoveryCases.detectorId })
      .from(recoveryCases)
      .where(
        and(
          eq(recoveryCases.orgId, orgId),
          eq(recoveryCases.runId, recoveryCase.runId),
          eq(
            recoveryCases.sourceNodeId,
            recoveryCase.sourceNodeId,
          ),
        ),
      )
      .orderBy(recoveryCases.detectorId)
      .limit(50),
  ]);
  const parsed = WorkflowSchema.safeParse(
    versionRows[0]?.dagJson ??
      workflowFromRunInput(runRows[0]?.inputJson),
  );
  const contract = parsed.success
    ? parsed.data.recovery?.contract
    : null;
  const detectorIds = [
    ...new Set(
      peerCases.length > 0
        ? peerCases.map((item) => item.detectorId)
        : [recoveryCase.detectorId],
    ),
  ];
  return combineRecoveryAutonomyProfiles(
    detectorIds.map((detectorId) =>
      resolveRecoveryAutonomyProfile(contract, {
        kind: "semantic",
        detectorId,
      }),
    ),
  );
}

export function isRecoveryCaseTerminal(state: string): boolean {
  return RECOVERY_CASE_TERMINAL_STATES.some(
    (terminal) => terminal === state,
  );
}

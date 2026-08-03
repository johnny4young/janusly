import {
  listAutoHealingAutonomyContexts,
  queryVerifiedAutoHealingRecoveries,
  type AutoHealingAutonomyContext,
  type AutoHealingRun,
} from "@janusly/data";
import {
  WorkflowSchema,
  classifyTechnicalRecoveryRepair,
  evaluateTechnicalRecoveryAutonomy,
  parseValidationEvidenceLevel,
  type TechnicalRecoveryAutonomyAssessment,
} from "@janusly/shared";

export type AutoHealingRunWithAutonomy = AutoHealingRun & {
  autonomyAssessment: TechnicalRecoveryAutonomyAssessment;
};

export async function assessAutoHealingAutonomyRows(
  orgId: string,
  rows: readonly AutoHealingRun[],
): Promise<AutoHealingRunWithAutonomy[]> {
  if (rows.length === 0) return [];
  const [contexts, counts] = await Promise.all([
    listAutoHealingAutonomyContexts(
      orgId,
      rows.map((row) => row.deadLetterId),
    ),
    queryVerifiedAutoHealingRecoveries(
      orgId,
      rows.map((row) => row.signature),
    ),
  ]);
  const contextById = new Map(
    contexts.map((context) => [context.deadLetterId, context]),
  );
  const countBySignature = new Map(
    counts.map((item) => [item.signature, item.count]),
  );
  return rows.map((row) => ({
    ...row,
    autonomyAssessment: buildAutoHealingAutonomyAssessment({
      row,
      context: contextById.get(row.deadLetterId) ?? null,
      priorVerifiedRecoveries: countBySignature.get(row.signature) ?? 0,
    }),
  }));
}

export async function assessAutoHealingAutonomyRow(
  row: AutoHealingRun,
  context?: AutoHealingAutonomyContext,
): Promise<TechnicalRecoveryAutonomyAssessment> {
  const [resolvedContext, counts] = await Promise.all([
    context
      ? Promise.resolve(context)
      : listAutoHealingAutonomyContexts(
          row.orgId,
          [row.deadLetterId],
        ).then((items) => items[0] ?? null),
    queryVerifiedAutoHealingRecoveries(row.orgId, [row.signature]),
  ]);
  return buildAutoHealingAutonomyAssessment({
    row,
    context: resolvedContext,
    priorVerifiedRecoveries: counts[0]?.count ?? 0,
  });
}

export function buildAutoHealingAutonomyAssessment(input: {
  row: AutoHealingRun;
  context: AutoHealingAutonomyContext | null;
  priorVerifiedRecoveries: number;
}): TechnicalRecoveryAutonomyAssessment {
  const original = WorkflowSchema.safeParse(input.context?.workflowJson);
  const candidate = WorkflowSchema.safeParse(input.row.proposedPatchJson);
  const failure =
    readErrorCode(input.context?.errorJson) === "worker_stalled"
      ? "stalled_node"
      : "terminal_node_failure";
  const repairClass =
    original.success && candidate.success && input.context
      ? classifyTechnicalRecoveryRepair({
          original: original.data,
          candidate: candidate.data,
          failingNodeId: input.context.nodeId,
        })
      : null;

  return evaluateTechnicalRecoveryAutonomy({
    contract: original.success
      ? original.data.recovery?.contract
      : null,
    failure,
    repairClass,
    validationEvidenceLevel: parseValidationEvidenceLevel(
      input.row.validationEvidenceLevel,
    ),
    priorVerifiedRecoveries: input.priorVerifiedRecoveries,
    affectedExecutions: 1,
    rollbackReady: original.success && candidate.success,
  });
}

function readErrorCode(value: unknown): string | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return typeof (value as Record<string, unknown>).code === "string"
    ? (value as Record<string, string>).code
    : null;
}

/**
 * Durable evidence for deterministic workflow outcome qualification.
 *
 * Version snapshots are immutable, so one exact baseline/candidate/dataset
 * tuple has one deterministic receipt. Repeated comparisons converge through
 * the unique database index instead of producing duplicate evidence rows.
 */

import { and, desc, eq, inArray, isNull } from "drizzle-orm";

import {
  db,
  workflowRecoveryQualifications,
  workflows,
  workflowVersions,
} from "@janusly/db";
import {
  WorkflowSchema,
  type Workflow,
} from "@janusly/shared";
import { safePersistPayload } from "@janusly/shared/src/safe-persist";

export type WorkflowRecoveryQualification =
  typeof workflowRecoveryQualifications.$inferSelect;

export type ResolvedQualificationVersion = {
  id: string;
  version: number;
  workflow: Workflow;
};

export type ResolveWorkflowRecoveryQualificationVersionsResult =
  | {
      kind: "resolved";
      baseline: ResolvedQualificationVersion;
      candidate: ResolvedQualificationVersion;
    }
  | {
      kind:
        | "not_found"
        | "invalid_versions"
        | "candidate_not_latest";
    };

/** Resolve and parse an exact immutable version pair for one active workflow. */
export async function resolveWorkflowRecoveryQualificationVersions(input: {
  orgId: string;
  workflowId: string;
  baselineVersionId: string;
  candidateVersionId: string;
}): Promise<ResolveWorkflowRecoveryQualificationVersionsResult> {
  const [parent] = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(
      and(
        eq(workflows.orgId, input.orgId),
        eq(workflows.id, input.workflowId),
        isNull(workflows.deletedAt),
      ),
    )
    .limit(1);
  if (!parent) return { kind: "not_found" };

  const versions = await db
    .select({
      id: workflowVersions.id,
      version: workflowVersions.version,
      dagJson: workflowVersions.dagJson,
    })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.orgId, input.orgId),
        eq(workflowVersions.workflowId, input.workflowId),
        inArray(workflowVersions.id, [
          input.baselineVersionId,
          input.candidateVersionId,
        ]),
      ),
    );
  const baseline = versions.find(
    (version) => version.id === input.baselineVersionId,
  );
  const candidate = versions.find(
    (version) => version.id === input.candidateVersionId,
  );
  if (
    !baseline
    || !candidate
    || baseline.version >= candidate.version
  ) {
    return { kind: "invalid_versions" };
  }

  const [latest] = await db
    .select({ id: workflowVersions.id })
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.orgId, input.orgId),
        eq(workflowVersions.workflowId, input.workflowId),
      ),
    )
    .orderBy(desc(workflowVersions.version))
    .limit(1);
  if (latest?.id !== candidate.id) {
    return { kind: "candidate_not_latest" };
  }

  const baselineWorkflow = WorkflowSchema.safeParse(baseline.dagJson);
  const candidateWorkflow = WorkflowSchema.safeParse(candidate.dagJson);
  if (!baselineWorkflow.success || !candidateWorkflow.success) {
    return { kind: "invalid_versions" };
  }
  return {
    kind: "resolved",
    baseline: {
      id: baseline.id,
      version: baseline.version,
      workflow: baselineWorkflow.data,
    },
    candidate: {
      id: candidate.id,
      version: candidate.version,
      workflow: candidateWorkflow.data,
    },
  };
}

/** Find the newest receipt for one exact version pair. */
export async function findWorkflowRecoveryQualification(input: {
  orgId: string;
  workflowId: string;
  baselineVersionId: string;
  candidateVersionId: string;
  datasetVersion?: string;
}): Promise<WorkflowRecoveryQualification | null> {
  const conditions = [
    eq(workflowRecoveryQualifications.orgId, input.orgId),
    eq(
      workflowRecoveryQualifications.workflowId,
      input.workflowId,
    ),
    eq(
      workflowRecoveryQualifications.baselineVersionId,
      input.baselineVersionId,
    ),
    eq(
      workflowRecoveryQualifications.candidateVersionId,
      input.candidateVersionId,
    ),
  ];
  if (input.datasetVersion) {
    conditions.push(
      eq(
        workflowRecoveryQualifications.datasetVersion,
        input.datasetVersion,
      ),
    );
  }
  const rows = await db
    .select()
    .from(workflowRecoveryQualifications)
    .where(and(...conditions))
    .orderBy(desc(workflowRecoveryQualifications.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Record one exact deterministic receipt.
 *
 * The summary is redacted and size-bounded before persistence. A repeated
 * request with the same fixture digest returns the existing immutable row.
 */
export async function recordWorkflowRecoveryQualification(input: {
  orgId: string;
  workflowId: string;
  baselineVersionId: string;
  candidateVersionId: string;
  datasetVersion: string;
  datasetDigest: string;
  mode: "bootstrap" | "compare";
  status: "passed" | "failed";
  summaryJson: unknown;
  createdBy: string;
}): Promise<WorkflowRecoveryQualification> {
  const id = crypto.randomUUID();
  await db
    .insert(workflowRecoveryQualifications)
    .values({
      id,
      orgId: input.orgId,
      workflowId: input.workflowId,
      baselineVersionId: input.baselineVersionId,
      candidateVersionId: input.candidateVersionId,
      datasetVersion: input.datasetVersion,
      datasetDigest: input.datasetDigest,
      mode: input.mode,
      status: input.status,
      summaryJson: safePersistPayload(input.summaryJson, {
        maxBytes: 64_000,
      }),
      createdBy: input.createdBy,
    })
    .onConflictDoNothing();

  const rows = await db
    .select()
    .from(workflowRecoveryQualifications)
    .where(
      and(
        eq(workflowRecoveryQualifications.orgId, input.orgId),
        eq(
          workflowRecoveryQualifications.workflowId,
          input.workflowId,
        ),
        eq(
          workflowRecoveryQualifications.baselineVersionId,
          input.baselineVersionId,
        ),
        eq(
          workflowRecoveryQualifications.candidateVersionId,
          input.candidateVersionId,
        ),
        eq(
          workflowRecoveryQualifications.datasetVersion,
          input.datasetVersion,
        ),
        eq(
          workflowRecoveryQualifications.datasetDigest,
          input.datasetDigest,
        ),
      ),
    )
    .limit(1);
  const receipt = rows[0];
  if (!receipt) {
    throw new Error("workflow_recovery_qualification_record_failed");
  }
  return receipt;
}

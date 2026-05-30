/**
 * Resolver for the recovery-item "audit evidence" export — the single
 * incident artefact a compliance buyer needs ("show me everything that
 * happened with this failure").
 *
 * `resolveRecoveryEvidence(orgId, recoveryItemId)` performs every
 * org-scoped DB read the pure builder
 * (`packages/engine/src/recovery-evidence-report.ts`) needs and returns
 * a flat snapshot bundle. The route layer
 * (`apps/api/src/routes/recovery-items-routes.ts:POST
 * /recovery/items/:id/evidence`) is thin: resolve → build → audit →
 * respond.
 *
 * Used by:
 *  - `apps/api/src/routes/recovery-items-routes.ts` (evidence export route)
 *
 * Invariants:
 *  - Multi-tenant scope on EVERY read. The recovery item, DLQ row, and
 *    audit rows all filter `eq(<table>.orgId, orgId)`. The run / run_nodes
 *    / run_events / validation-run reads are reached only through ids that
 *    were already org-gated (the DLQ row's `runId`, the run's
 *    `workflowVersionId`), so a cross-org id leaks nothing — `null`
 *    recovery item short-circuits before any downstream read.
 *  - Cascade posture: orphan-tolerant. A recovery item can outlive its
 *    DLQ row (no FK), and a DLQ row can reference a deleted run version.
 *    Every snapshot field is independently nullable so the builder
 *    renders a partial artefact rather than throwing.
 *  - The run-event read is BOUNDED (`RUN_EVENT_FETCH_CAP`) so a noisy run
 *    can't blow the response. The builder applies its own per-artefact
 *    timeline cap on top; this read is a comfortable multiple of it.
 */

import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import {
  auditLogs,
  db,
  deadLetters,
  recoveryItems,
  runEvents,
  runNodes,
  runs,
  workflowVersions,
} from "@janusly/db";

/** Upper bound on `run_events` rows pulled for the timeline. The builder caps the rendered slice well below this. */
export const RUN_EVENT_FETCH_CAP = 300;
/** Upper bound on related audit rows pulled per evidence export. */
export const EVIDENCE_AUDIT_CAP = 200;

/** Raw `recovery_items` snapshot the evidence builder needs. */
export type EvidenceRecoveryItem = {
  id: string;
  deadLetterId: string;
  workflowId: string | null;
  owner: string | null;
  severity: string;
  status: string;
  slaTargetAt: Date | null;
  resolutionReason: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  errorSignature: string | null;
  occurrenceCount: number;
  comments: Array<{ id: string; authorUserId: string; body: string; createdAt: string }>;
  createdAt: Date | null;
  updatedAt: Date | null;
};

/** Raw `dead_letters` snapshot. */
export type EvidenceDeadLetter = {
  id: string;
  runId: string;
  nodeId: string;
  attempt: number;
  status: string;
  /** Original (failing) workflow snapshot — the `before` side of the patch diff. Already key-redacted at write time. */
  workflowJson: unknown;
  nodeJson: unknown;
  errorJson: unknown;
  replayedAt: Date | null;
  createdAt: Date | null;
};

/** Raw `runs` snapshot (original failing run OR a sandbox validation run). */
export type EvidenceRun = {
  id: string;
  status: string;
  workflowVersionId: string | null;
  parentRunId: string | null;
  replayMode: string | null;
  inputJson: unknown;
  outputJson: unknown;
  createdAt: Date | null;
};

/** Raw `run_nodes` snapshot. */
export type EvidenceRunNode = {
  nodeId: string;
  status: string;
  attempts: number | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  stateJson: unknown;
  errorJson: unknown;
};

/** Raw `run_events` snapshot. */
export type EvidenceRunEvent = {
  id: string;
  nodeId: string | null;
  type: string;
  createdAt: Date | null;
  payload: unknown;
};

/** Raw `audit_logs` snapshot for rows referencing the run / DLQ / recovery item. */
export type EvidenceAuditRow = {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  userId: string | null;
  metadata: unknown;
  createdAt: Date | null;
};

/** The full snapshot bundle the pure builder consumes. */
export type RecoveryEvidenceBundle = {
  recoveryItem: EvidenceRecoveryItem;
  deadLetter: EvidenceDeadLetter | null;
  /** Original failing run (from `dead_letters.runId`), if it still exists. */
  originalRun: EvidenceRun | null;
  /** Node + event timeline of the original run. */
  originalRunNodes: EvidenceRunNode[];
  originalRunEvents: EvidenceRunEvent[];
  /** Whether the original-run event read hit the fetch cap (older rows exist). */
  originalRunEventsTruncated: boolean;
  /** Most-recent sandbox validation run for the original run (replayMode="validation"), if any. */
  validationRun: EvidenceRun | null;
  /** Failing/failed nodes of the validation run, used to surface the sandbox outcome. */
  validationRunNodes: EvidenceRunNode[];
  /** Audit rows referencing the run id, DLQ id, or recovery-item id (capped, newest first). */
  auditRows: EvidenceAuditRow[];
  /** Prior workflow version (for the rollback link), if the failing run targeted a saved workflow with ≥2 versions. */
  rollback: { workflowId: string; currentVersion: number; priorVersion: number } | null;
};

function asComments(value: unknown): EvidenceRecoveryItem["comments"] {
  if (!Array.isArray(value)) return [];
  return value as EvidenceRecoveryItem["comments"];
}

/**
 * Resolve every snapshot the evidence builder needs for one recovery
 * item. Returns `null` when the recovery item doesn't belong to `orgId`
 * (or doesn't exist) — the route 404s uniformly with no enumeration
 * distinction. Every downstream read is reached only through ids already
 * org-gated by the recovery item / DLQ row.
 */
export async function resolveRecoveryEvidence(
  orgId: string,
  recoveryItemId: string,
): Promise<RecoveryEvidenceBundle | null> {
  const itemRows = await db
    .select()
    .from(recoveryItems)
    .where(and(eq(recoveryItems.orgId, orgId), eq(recoveryItems.id, recoveryItemId)));
  const itemRow = itemRows[0];
  if (!itemRow) return null;

  const recoveryItem: EvidenceRecoveryItem = {
    id: itemRow.id,
    deadLetterId: itemRow.deadLetterId,
    workflowId: itemRow.workflowId,
    owner: itemRow.owner,
    severity: itemRow.severity,
    status: itemRow.status,
    slaTargetAt: itemRow.slaTargetAt ?? null,
    resolutionReason: itemRow.resolutionReason,
    resolvedBy: itemRow.resolvedBy,
    resolvedAt: itemRow.resolvedAt ?? null,
    errorSignature: itemRow.errorSignature,
    occurrenceCount: itemRow.occurrenceCount,
    comments: asComments(itemRow.comments),
    createdAt: itemRow.createdAt ?? null,
    updatedAt: itemRow.updatedAt ?? null,
  };

  // DLQ row — org-scoped. The unique `(orgId, deadLetterId)` index makes
  // this 1:1, but the row may be gone (orphan-tolerant) so guard for null.
  const dlqRows = await db
    .select()
    .from(deadLetters)
    .where(and(eq(deadLetters.orgId, orgId), eq(deadLetters.id, recoveryItem.deadLetterId)));
  const dlqRow = dlqRows[0] ?? null;
  const deadLetter: EvidenceDeadLetter | null = dlqRow
    ? {
        id: dlqRow.id,
        runId: dlqRow.runId,
        nodeId: dlqRow.nodeId,
        attempt: dlqRow.attempt,
        status: dlqRow.status,
        workflowJson: dlqRow.workflowJson,
        nodeJson: dlqRow.nodeJson,
        errorJson: dlqRow.errorJson,
        replayedAt: dlqRow.replayedAt ?? null,
        createdAt: dlqRow.createdAt ?? null,
      }
    : null;

  const originalRunId = deadLetter?.runId ?? null;

  // Original run + its timeline. Reached only through the DLQ row's
  // runId, which arrived via the org-scoped DLQ read above. We still
  // re-scope the run read with `eq(runs.orgId, orgId)` as defense in
  // depth so a corrupt DLQ row can't pull a foreign run.
  let originalRun: EvidenceRun | null = null;
  let originalRunNodes: EvidenceRunNode[] = [];
  let originalRunEvents: EvidenceRunEvent[] = [];
  let originalRunEventsTruncated = false;
  let validationRun: EvidenceRun | null = null;
  let validationRunNodes: EvidenceRunNode[] = [];

  if (originalRunId) {
    const runRows = await db
      .select()
      .from(runs)
      .where(and(eq(runs.id, originalRunId), eq(runs.orgId, orgId)));
    const runRow = runRows[0] ?? null;
    if (runRow) {
      originalRun = mapRun(runRow);

      const nodeRows = await db
        .select()
        .from(runNodes)
        .where(eq(runNodes.runId, originalRunId))
        .orderBy(asc(runNodes.startedAt), asc(runNodes.nodeId));
      originalRunNodes = nodeRows.map(mapRunNode);

      const eventRows = await db
        .select()
        .from(runEvents)
        .where(eq(runEvents.runId, originalRunId))
        .orderBy(desc(runEvents.createdAt), desc(runEvents.id))
        .limit(RUN_EVENT_FETCH_CAP + 1);
      originalRunEventsTruncated = eventRows.length > RUN_EVENT_FETCH_CAP;
      originalRunEvents = (originalRunEventsTruncated ? eventRows.slice(0, RUN_EVENT_FETCH_CAP) : eventRows).map(
        mapRunEvent,
      );
    }

    // Most-recent sandbox validation run for this failing run. The
    // recovery dialog seeds `parentRunId = originalRunId` and
    // `replayMode = "validation"`; the patched workflow snapshot lives in
    // its `inputJson.workflow`. Org-scoped.
    const validationRows = await db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.orgId, orgId),
          eq(runs.parentRunId, originalRunId),
          eq(runs.replayMode, "validation"),
        ),
      )
      .orderBy(desc(runs.createdAt))
      .limit(1);
    const validationRow = validationRows[0] ?? null;
    if (validationRow) {
      validationRun = mapRun(validationRow);
      const valNodeRows = await db
        .select()
        .from(runNodes)
        .where(eq(runNodes.runId, validationRow.id))
        .orderBy(asc(runNodes.startedAt), asc(runNodes.nodeId));
      validationRunNodes = valNodeRows.map(mapRunNode);
    }
  }

  // Audit rows scoped to (runId, deadLetterId, recoveryItemId). All
  // org-scoped. We match on `targetId` (direct entity reference) OR a
  // `metadata` cross-reference: patch suggestions stamp `metadata.runId`,
  // validation starts stamp `metadata.validationRunId`. Newest first,
  // capped.
  const auditRefs: string[] = [recoveryItem.id, recoveryItem.deadLetterId];
  if (originalRunId) auditRefs.push(originalRunId);
  if (validationRun) auditRefs.push(validationRun.id);
  const metadataMatchers = [
    originalRunId ? sql`${auditLogs.metadata} ->> 'runId' = ${originalRunId}` : null,
    validationRun ? sql`${auditLogs.metadata} ->> 'validationRunId' = ${validationRun.id}` : null,
  ].filter((m): m is NonNullable<typeof m> => m !== null);
  const auditRows = await db
    .select()
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.orgId, orgId),
        or(
          // targetId directly references one of our entities
          inArray(auditLogs.targetId, auditRefs),
          ...metadataMatchers,
        ),
      ),
    )
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(EVIDENCE_AUDIT_CAP);
  const evidenceAuditRows: EvidenceAuditRow[] = auditRows.map((row) => ({
    id: row.id,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    userId: row.userId,
    metadata: row.metadata,
    createdAt: row.createdAt ?? null,
  }));

  // Rollback link — surface the prior version number so the operator can
  // jump to "Roll back to v{N-1}" in the UI. Resolved from the failing
  // run's saved-workflow lineage. Only present when the run targeted a
  // saved workflow (a `workflow_versions` row matches the run's
  // `workflowVersionId`) AND ≥2 versions exist.
  let rollback: RecoveryEvidenceBundle["rollback"] = null;
  const wfVersionId = originalRun?.workflowVersionId ?? null;
  if (wfVersionId) {
    const versionRows = await db
      .select({ workflowId: workflowVersions.workflowId, version: workflowVersions.version })
      .from(workflowVersions)
      .where(and(eq(workflowVersions.orgId, orgId), eq(workflowVersions.id, wfVersionId)));
    const currentVersionRow = versionRows[0] ?? null;
    if (currentVersionRow) {
      const priorRows = await db
        .select({ version: workflowVersions.version })
        .from(workflowVersions)
        .where(
          and(
            eq(workflowVersions.orgId, orgId),
            eq(workflowVersions.workflowId, currentVersionRow.workflowId),
            lt(workflowVersions.version, currentVersionRow.version),
          ),
        )
        .orderBy(desc(workflowVersions.version))
        .limit(1);
      const priorVersion = priorRows[0]?.version ?? null;
      if (priorVersion !== null) {
        rollback = {
          workflowId: currentVersionRow.workflowId,
          currentVersion: currentVersionRow.version,
          priorVersion,
        };
      }
    }
  }

  return {
    recoveryItem,
    deadLetter,
    originalRun,
    originalRunNodes,
    originalRunEvents,
    originalRunEventsTruncated,
    validationRun,
    validationRunNodes,
    auditRows: evidenceAuditRows,
    rollback,
  };
}

function mapRun(row: typeof runs.$inferSelect): EvidenceRun {
  return {
    id: row.id,
    status: row.status,
    workflowVersionId: row.workflowVersionId ?? null,
    parentRunId: row.parentRunId ?? null,
    replayMode: row.replayMode ?? null,
    inputJson: row.inputJson,
    outputJson: row.outputJson,
    createdAt: row.createdAt ?? null,
  };
}

function mapRunNode(row: typeof runNodes.$inferSelect): EvidenceRunNode {
  return {
    nodeId: row.nodeId,
    status: row.status,
    attempts: row.attempts ?? null,
    startedAt: row.startedAt ?? null,
    finishedAt: row.finishedAt ?? null,
    stateJson: row.stateJson,
    errorJson: row.errorJson,
  };
}

function mapRunEvent(row: typeof runEvents.$inferSelect): EvidenceRunEvent {
  return {
    id: row.id,
    nodeId: row.nodeId ?? null,
    type: row.type,
    createdAt: row.createdAt ?? null,
    payload: row.payload,
  };
}

// Multi-tenant invariant: tenant-scoped reads keep orgId in the predicate; downstream reads are reached only through org-gated ids - see AGENTS.md "Decision engine / RL".

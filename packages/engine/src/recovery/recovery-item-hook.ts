/**
 * Production helpers bridging the DLQ lifecycle with the
 * `recovery_items` subsystem. Lives in `@janusly/engine` (not `apps/api`)
 * because the worker process also needs to register the creator — the
 * worker is the primary DLQ writer, so a helper that only registered in
 * api would miss every real worker-side DLQ insert.
 *
 * Two helpers:
 *  - `createRecoveryItemForDeadLetter` — registered as the production
 *    `RecoveryItemCreator` from `@janusly/data/src/recovery-item-creator`
 *    at BOTH api and worker boot. Honours
 *    `org_configs.recovery.autoCreateItems` (default `true`). Idempotent
 *    on `(orgId, deadLetterId)` so cluster-apply fan-out is safe.
 *  - `autoResolveRecoveryItemFromReplay` — called from
 *    `/dlq/replay` and `/dlq/resolve` and the `/dlq/cluster-apply` loop
 *    after the DLQ row is marked replayed / resolved.
 *
 * Both helpers NEVER throw. Audit writes go inline via
 * `db.insert(auditLogs)` + the shared `safePersistPayload` chokepoint
 * (same posture as `packages/engine/src/alerts/dispatcher.ts`), because
 * the api-side `audit()` helper isn't importable from engine.
 */

import { auditLogs, db } from "@janusly/db";
import {
  getOrgConfigSnapshot,
  createRecoveryItem,
  getRecoveryItemByDeadLetterId,
  resolveRecoveryItem,
  recordAlertEvent,
  getRecoveryItemSeverityDefault,
} from "@janusly/data";

import { safePersistPayload } from "../safe-persist";

const AUDIT_METADATA_MAX_BYTES = 64_000;

/** Inline audit writer. Mirrors `apps/api/src/audit.ts` byte-for-byte. */
async function writeAuditRow(input: {
  orgId: string;
  userId: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      orgId: input.orgId,
      userId: input.userId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      metadata: safePersistPayload(input.metadata, { maxBytes: AUDIT_METADATA_MAX_BYTES }),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[recovery-item-hook] audit write failed", { action: input.action, err });
  }
}

/** Read the per-org toggle `recovery.autoCreateItems`; defaults to `true` when unset. */
async function isAutoCreateEnabled(orgId: string): Promise<boolean> {
  try {
    const snapshot = await getOrgConfigSnapshot(orgId);
    return snapshot.recovery.autoCreateItems;
  } catch {
    return true;
  }
}

export type CreateRecoveryItemForDeadLetterInput = {
  orgId: string;
  deadLetterId: string;
  createdBy: string;
  workflowId?: string | null;
  errorSignature?: string | null;
};

/** Idempotent recovery_item creation + audit + alert emission. */
export async function createRecoveryItemForDeadLetter(
  input: CreateRecoveryItemForDeadLetterInput,
): Promise<void> {
  try {
    const enabled = await isAutoCreateEnabled(input.orgId);
    if (!enabled) return;
    // Per-workflow severity default: when the workflow's metadata row
    // declares one, use it instead of the repo's hardcoded 'p3'. Failures
    // (Postgres blip, missing seam) degrade to null so the existing
    // default applies. SLA target derives from severity inside
    // `createRecoveryItem`, so a p1 default automatically tightens the
    // timer without the operator touching each incident.
    const severityDefault = input.workflowId
      ? await getRecoveryItemSeverityDefault(input.orgId, input.workflowId)
      : null;
    const { item, wasCreated } = await createRecoveryItem({
      orgId: input.orgId,
      deadLetterId: input.deadLetterId,
      workflowId: input.workflowId ?? null,
      createdBy: input.createdBy,
      ...(severityDefault ? { severity: severityDefault } : {}),
    });
    if (!wasCreated) return;

    await writeAuditRow({
      orgId: input.orgId,
      userId: input.createdBy,
      action: "recovery.item.created",
      targetType: "recovery-item",
      targetId: item.id,
      metadata: {
        deadLetterId: input.deadLetterId,
        severity: item.severity,
        slaTargetAt: item.slaTargetAt.toISOString(),
        workflowId: input.workflowId ?? null,
        errorSignature: input.errorSignature ?? null,
      },
    });

    await recordAlertEvent({
      orgId: input.orgId,
      trigger: "recovery_item.created",
      payload: {
        itemId: item.id,
        deadLetterId: input.deadLetterId,
        severity: item.severity,
        workflowId: input.workflowId ?? null,
        errorSignature: input.errorSignature ?? null,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[recovery-item-hook] createRecoveryItemForDeadLetter failed", {
      orgId: input.orgId,
      deadLetterId: input.deadLetterId,
      err,
    });
  }
}

export type AutoResolveRecoveryItemFromReplayInput = {
  orgId: string;
  deadLetterId: string;
  actor: string;
  resolutionReason?: "sandbox_replay_succeeded" | "accepted_loss";
  via?: string;
};

/** Closes the recovery_item linked to a replayed DLQ row. Safe to call when no item exists. */
export async function autoResolveRecoveryItemFromReplay(
  input: AutoResolveRecoveryItemFromReplayInput,
): Promise<void> {
  try {
    const item = await getRecoveryItemByDeadLetterId(input.orgId, input.deadLetterId);
    if (!item) return;
    if (item.status === "resolved") return;
    const resolutionReason = input.resolutionReason ?? "sandbox_replay_succeeded";
    const via = input.via ?? "dlq_replay";
    const result = await resolveRecoveryItem(input.orgId, item.id, {
      actor: input.actor,
      reason: resolutionReason,
    });
    if (!result) return;
    await writeAuditRow({
      orgId: input.orgId,
      userId: input.actor,
      action: "recovery.item.resolved",
      targetType: "recovery-item",
      targetId: item.id,
      metadata: {
        before: { status: result.before.status, resolutionReason: result.before.resolutionReason },
        after: { status: result.after.status, resolutionReason: result.after.resolutionReason },
        resolutionReason,
        via,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[recovery-item-hook] autoResolveRecoveryItemFromReplay failed", {
      orgId: input.orgId,
      deadLetterId: input.deadLetterId,
      err,
    });
  }
}

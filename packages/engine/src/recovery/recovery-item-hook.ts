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
  findOpenRecoveryItemForDebounce,
  attachDeadLetterToRecoveryItem,
} from "@janusly/data";

import { safePersistPayload } from "../safe-persist";

const AUDIT_METADATA_MAX_BYTES = 64_000;

/**
 * Debounce window clamp. A configured value of 0 disables debounce
 * entirely (one incident per DLQ row); any non-zero value is clamped into
 * this range so a typo like `5` can't collapse genuinely-distinct failures
 * and a huge value can't keep a stale incident absorbing forever.
 */
const DEBOUNCE_MIN_SECONDS = 30;
const DEBOUNCE_MAX_SECONDS = 3_600;

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

/** The two per-org recovery toggles this hook consults, read in one snapshot fetch. */
type RecoveryHookConfig = { autoCreate: boolean; debounceWindowSeconds: number };

/**
 * Read `recovery.autoCreateItems` + `recovery.debounceWindowSeconds` in a
 * single snapshot fetch. On any read failure we default to auto-create ON
 * (the ownership workflow is the safe default) and debounce OFF (never
 * wrongly group failures when we can't read the window).
 */
async function getRecoveryHookConfig(orgId: string): Promise<RecoveryHookConfig> {
  try {
    const snapshot = await getOrgConfigSnapshot(orgId);
    return {
      autoCreate: snapshot.recovery.autoCreateItems,
      debounceWindowSeconds: snapshot.recovery.debounceWindowSeconds,
    };
  } catch {
    return { autoCreate: true, debounceWindowSeconds: 0 };
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
    const config = await getRecoveryHookConfig(input.orgId);
    if (!config.autoCreate) return;

    // Failure-storm debounce: when a still-open incident shares the
    // (orgId, workflowId, errorSignature) key and its last occurrence is
    // within the configured window, record this DLQ row as a child
    // occurrence of that incident instead of spawning a new one. The
    // alert is intentionally skipped on the attach path so a storm pages
    // the operator once, not once per repetition. window <= 0 disables;
    // a signature-less failure can't be grouped.
    if (config.debounceWindowSeconds > 0 && input.errorSignature) {
      const windowSeconds = Math.min(
        Math.max(config.debounceWindowSeconds, DEBOUNCE_MIN_SECONDS),
        DEBOUNCE_MAX_SECONDS,
      );
      const notBefore = new Date(Date.now() - windowSeconds * 1_000);
      const parent = await findOpenRecoveryItemForDebounce({
        orgId: input.orgId,
        workflowId: input.workflowId ?? null,
        errorSignature: input.errorSignature,
        notBefore,
      });
      if (parent) {
        // Defensive: a re-invocation for the SAME DLQ row would otherwise
        // attach the row to the very incident it created. The incident
        // already represents this failure — nothing to bump.
        if (parent.deadLetterId === input.deadLetterId) return;
        const attached = await attachDeadLetterToRecoveryItem({
          orgId: input.orgId,
          recoveryItemId: parent.id,
          deadLetterId: input.deadLetterId,
        });
        if (attached) {
          await writeAuditRow({
            orgId: input.orgId,
            userId: input.createdBy,
            action: "recovery.item.occurrence_attached",
            targetType: "recovery-item",
            targetId: parent.id,
            metadata: {
              deadLetterId: input.deadLetterId,
              occurrenceCount: attached.occurrenceCount,
              errorSignature: input.errorSignature,
              workflowId: input.workflowId ?? null,
            },
          });
        }
        return;
      }
    }

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
      errorSignature: input.errorSignature ?? null,
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

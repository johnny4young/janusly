/**
 * Best-effort audit writer for SYSTEM actors — schedulers, pollers,
 * reconcilers, dispatchers. The non-transactional sibling of
 * `audit-tx.ts:withAuditTx` (entity + audit committing together) and of the
 * api-side `auditAction` (route-layer writes with an authenticated actor).
 *
 * Before this module, eight engine files carried their own inline
 * `db.insert(auditLogs)` — three of them re-declaring an identical private
 * `writeAuditRow`. One chokepoint means the metadata cap, the redaction
 * (`safePersistPayload`), and the never-throw posture can't drift apart
 * per caller.
 *
 * Used by: `packages/engine/src/upstream-health-poller.ts`,
 * `recovery/recovery-item-hook.ts`, `alerts/dispatcher.ts`,
 * `stalled-node-reaper.ts`, the retention/calibration/SCIM schedulers.
 *
 * Invariants:
 * - NEVER throws: an audit write is telemetry about system work already
 *   done; a failed insert must not break the sweep/poll/dispatch itself.
 * - Metadata goes through `safePersistPayload` with the same 256 KB cap
 *   the previous inline writers used.
 * - `actor: null` means "unattributed system sweep" (the retention
 *   convention); named system actors use the `system:<component>` form.
 */

import { auditLogs, db } from "@janusly/db";

// Deep import on purpose — mirrors the data layer's other system-audit
// writers; `safe-persist` is deliberately not in the shared barrel.
import { safePersistPayload } from "@janusly/shared/src/safe-persist";

/** Same cap the engine's inline writers carried (`AUDIT_METADATA_MAX_BYTES`). */
export const SYSTEM_AUDIT_METADATA_MAX_BYTES = 256 * 1024;

export type SystemAuditInput = {
  /** Tenant scope, or the `"system"` sentinel for cross-org sweeps. */
  orgId: string;
  /** Audit action key (dot-form, e.g. `upstream.source.paused`). */
  action: string;
  /**
   * Who did it. `null` (default) = unattributed system sweep;
   * `system:<component>` for named system actors; a real user id when the
   * system acts on a user's behalf (e.g. recovery-item creation).
   */
  actor?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  /**
   * Log tag for the swallow-and-warn path, e.g. `[upstream-health]`.
   * Defaults to `[system-audit]` so a failure is never fully silent.
   */
  logTag?: string;
  /**
   * Metadata size cap. Defaults to the 256 KB the engine writers used;
   * the alert dispatcher keeps its historical 64 KB.
   */
  maxBytes?: number;
};

/** Insert one system audit row. Best-effort: failures warn, never throw. */
export async function recordSystemAudit(input: SystemAuditInput): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      orgId: input.orgId,
      userId: input.actor ?? null,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      metadata: safePersistPayload(input.metadata ?? {}, {
        maxBytes: input.maxBytes ?? SYSTEM_AUDIT_METADATA_MAX_BYTES,
      }) as Record<string, unknown>,
    });
  } catch (err) {
    console.warn(`${input.logTag ?? "[system-audit]"} audit write failed`, {
      action: input.action,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

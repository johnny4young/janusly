/**
 * DI seam for the recovery ownership subsystem. Decouples the DLQ
 * adapter (in `@janusly/engine`) from the api-side helper that actually
 * creates `recovery_items` rows + audits + dispatches the
 * `recovery_item.created` alert event.
 *
 * Production wiring lives in `apps/api/src/index.ts` (and the worker
 * process boot) which calls `setRecoveryItemCreator(creator)` once at
 * startup. Mirror of the `setAlertDispatcher` pattern from
 * `alert-dispatch.ts`.
 *
 * Invariants:
 *  - Never throws on the caller. The DLQ adapter must not be broken by
 *    a downstream failure in the recovery subsystem.
 *  - When no creator is registered the seam is a silent no-op — used by
 *    tests and by processes that boot without the recovery module.
 */

export type RecoveryItemCreationEvent = {
  orgId: string;
  deadLetterId: string;
  /** Optional fields the DLQ adapter may pass when known. */
  workflowId?: string | null;
  errorSignature?: string | null;
  createdBy?: string | null;
};

export type RecoveryItemCreator = (event: RecoveryItemCreationEvent) => Promise<void>;

let creator: RecoveryItemCreator | null = null;

/** Register the production creator. Last write wins. */
export function setRecoveryItemCreator(c: RecoveryItemCreator | null): void {
  creator = c;
}

/**
 * Record a recovery-item creation request. Never throws on the caller —
 * a downstream failure (auto-create disabled, DB blip) logs a warning
 * and returns.
 */
export async function recordRecoveryItemCreationEvent(
  event: RecoveryItemCreationEvent,
): Promise<void> {
  if (!creator) return;
  try {
    await creator(event);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[recovery-item-creator] creator threw", {
      err,
      orgId: event.orgId,
      deadLetterId: event.deadLetterId,
    });
  }
}

export function getRecoveryItemCreator(): RecoveryItemCreator | null {
  return creator;
}

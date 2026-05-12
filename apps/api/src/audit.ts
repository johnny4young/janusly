/**
 * Audit-log writer used by every mutating API route.
 *
 * Wraps the underlying `db.insert(auditLogs)` with the safe-persist
 * chokepoint so sensitive-keyed metadata (`secret*`, `token*`,
 * `Authorization`, etc.) is scrubbed before persistence. The 64 KB cap
 * keeps audit rows readable in a console without truncating the row's
 * action / target columns; over-cap payloads land as a `__truncated`
 * sentinel.
 *
 * Used by per-surface route modules under `apps/api/src/routes/*`.
 *
 * Invariants:
 * - Every mutation writes one row with a stable `action` string.
 * - AI mutations write audit on AI-mode AND on fallback (per the
 *   AGENTS.md AI-fallback contract).
 * - Failures are caught + warned, never thrown — audit must not break
 *   the enclosing route.
 */

import { db, auditLogs } from "@janusly/db";
import { safePersistPayload } from "@janusly/engine/src/safe-persist";

// Audit metadata cap — audit rows are read by humans and should stay tight.
// 64 KB lets a row carry an explanation + a small input snapshot but caps
// before a megabyte of caller payload sneaks into the audit log.
export const AUDIT_METADATA_MAX_BYTES = 64_000;

export async function audit(
  orgId: string,
  userId: string,
  action: string,
  targetType?: string,
  targetId?: string,
  metadata: unknown = {},
): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      orgId,
      userId,
      action,
      targetType,
      targetId,
      // Sanitizer chokepoint scrubs sensitive keys (`secret*`, `token*`,
      // `Authorization`, etc.) and bounds the row size with a `__truncated`
      // sentinel for over-cap payloads. Same sensitive-key regex the
      // engine writes go through, so audit + run_events stay consistent.
      metadata: safePersistPayload(metadata, { maxBytes: AUDIT_METADATA_MAX_BYTES }),
    });
  } catch (error) {
    console.warn("audit write failed", error);
  }
}

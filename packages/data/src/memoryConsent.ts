/**
 * Memory write/recall consent policy.
 *
 * Persistent cross-run memory (recovery rationales, run summaries,
 * runbook fragments, patch rationales) is gated by a two-flag opt-in
 * posture documented in `docs/memory-policy.md`. Both flags must be
 * true for any commit or recall to proceed; either being false rejects
 * the operation with a stable `memory_disabled` code that callers map
 * to an empty result (recall path) or a `{ ok: false }` envelope
 * (commit path).
 *
 *   1. Process-wide opt-in: `JANUSLY_MEMORY_ENABLED=true` (default
 *      false). The engineering kill switch. A misconfigured tenant
 *      cannot turn this on.
 *   2. Per-tenant opt-in: `org_configs.memory.enabled === true`
 *      (default false). Set per organization by an admin via the
 *      standard org-config API. Tenants that never opted in stay
 *      locked even if the operator flips the env.
 *
 * Mirrors the `isMcpWriteAllowed` posture in `apps/api/src/mcp-consent.ts` —
 * the symmetry is deliberate (the memory policy cites it as a binding
 * precedent). The helper lives in `@janusly/data` (not `apps/api`) because
 * `memoryEntriesRepo` is called from multiple non-HTTP contexts (engine
 * workflow steps, retention jobs) that have no route-layer guard.
 *
 * Used by:
 * - `packages/data/src/memoryEntriesRepo.ts` — `commitMemory` and
 *   `recallMemory` call this before memory DB writes or reads. The
 *   retention sweep operates on already-expired rows and does not use
 *   tenant consent as its safety gate.
 * - `apps/api/src/routes/*` (future) — route handlers can call this
 *   directly to surface a 403 with the stable `reason` code.
 *
 * Invariants:
 * - Multi-tenant scope: the tenant flag is read via
 *   `getOrgConfigSnapshot`, which already filters by `orgId`.
 * - Failures NEVER throw — `{ allowed: false, reason }` lets callers
 *   degrade gracefully (empty recall, audited warn).
 */

import { getOrgConfigSnapshot } from "./orgConfigRepo";

export type MemoryAllowedResult =
  | { allowed: true }
  | {
      allowed: false;
      reason: "process_disabled" | "tenant_disabled" | "config_unavailable";
      message: string;
    };

/**
 * True only when both the process-wide env and the tenant flag are on.
 * Callers (`memoryEntriesRepo`) invoke this once before any DB work.
 */
export async function isMemoryAllowed(orgId: string): Promise<MemoryAllowedResult> {
  if (process.env.JANUSLY_MEMORY_ENABLED !== "true") {
    return {
      allowed: false,
      reason: "process_disabled",
      message:
        "Memory is disabled at the process level (JANUSLY_MEMORY_ENABLED is not 'true').",
    };
  }
  let snapshot: Awaited<ReturnType<typeof getOrgConfigSnapshot>>;
  try {
    snapshot = await getOrgConfigSnapshot(orgId);
  } catch (error) {
    console.warn("[memory] consent config read failed", { orgId, error });
    return {
      allowed: false,
      reason: "config_unavailable",
      message:
        "Memory consent could not be read for this organization; memory is disabled fail-closed.",
    };
  }
  if (!snapshot.memory.enabled) {
    return {
      allowed: false,
      reason: "tenant_disabled",
      message:
        "Memory is not consented for this organization (memory.enabled is false).",
    };
  }
  return { allowed: true };
}

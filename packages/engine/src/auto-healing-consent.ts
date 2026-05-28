/**
 * Supervised auto-healing consent policy. The background scanner +
 * watcher run continuously across all tenants, so the consent gates
 * MUST be re-evaluated at every step (master gate before any LLM
 * call, auto-apply gate before any production replay). Mirrors the
 * MCP-write two-flag pattern: process env ANDed with per-tenant
 * `org_configs.autoHealing.*`.
 *
 * Two independent flag pairs:
 *
 *   1. **Master gate** — `JANUSLY_AUTO_HEALING_ENABLED=true` (process,
 *      default false) AND `org_configs.autoHealing.enabled === true`
 *      (tenant, default false). Either being false means the scanner
 *      skips this org entirely; zero auto-healing activity, zero
 *      audit rows, zero LLM spend.
 *
 *   2. **Auto-apply gate** — `JANUSLY_AUTO_HEALING_AUTO_APPLY=true`
 *      (process, default false) AND `org_configs.autoHealing.autoApply
 *      === true` (tenant, default false). Either being false means
 *      the watcher leaves validated rows in `validated` state for
 *      manual operator decision via the Recovery Center card.
 *
 * Both pairs MUST be true for the auto-apply branch to fire. Even
 * then, the watcher still requires successful sandbox validation,
 * stable failure signature, budget pass, and a per-`(orgId, signature)`
 * loop-breaker count below the cap — auto-apply is "everything else
 * also said yes", not "skip the safety nets".
 *
 * Lives in `packages/engine` (not `apps/api`) because the engine-side
 * scanner is the primary caller; the API decision route imports it
 * via a thin re-export in `apps/api/src/auto-healing-consent.ts`.
 *
 * Used by:
 * - `packages/engine/src/auto-healing-scanner.ts` — master gate
 *   before any candidate work.
 * - `packages/engine/src/auto-healing-watcher.ts` — auto-apply gate
 *   before triggering production replay.
 * - `apps/api/src/auto-healing-consent.ts` — thin re-export so the
 *   API decision route uses the same gate logic.
 *
 * Invariants:
 * - Fail-closed: any error reading the org-config snapshot returns
 *   `{ allowed: false, reason: "tenant_disabled" }` and the scanner
 *   skips the org. A consent gate that silently allows on infra
 *   failure is unacceptable for a write-side feature.
 * - Multi-tenant scope: the tenant flag is read via
 *   `getOrgConfigSnapshot`, which already filters by `orgId`. There
 *   is no cross-tenant escape.
 */

import {
  getOrgConfigSnapshot,
} from "@janusly/data";

export type AutoHealingConsentResult =
  | { allowed: true }
  | { allowed: false; reason: "process_disabled" | "tenant_disabled"; message: string };

/**
 * Master gate. Required true at every scanner candidate evaluation
 * AND at every watcher tick. Cheap — one `getOrgConfigSnapshot` call
 * which already caches the per-org `org_configs` row.
 */
export async function isAutoHealingAllowed(orgId: string): Promise<AutoHealingConsentResult> {
  if (process.env.JANUSLY_AUTO_HEALING_ENABLED !== "true") {
    return {
      allowed: false,
      reason: "process_disabled",
      message:
        "Auto-healing is disabled at the process level (JANUSLY_AUTO_HEALING_ENABLED is not 'true').",
    };
  }
  try {
    const snapshot = await getOrgConfigSnapshot(orgId);
    if (!snapshot.autoHealing.enabled) {
      return {
        allowed: false,
        reason: "tenant_disabled",
        message:
          "Auto-healing is not consented for this organization (autoHealing.enabled is false).",
      };
    }
    return { allowed: true };
  } catch (err) {
    console.warn("[auto-healing] consent read failed; fail-closed", { orgId, err });
    return {
      allowed: false,
      reason: "tenant_disabled",
      message:
        "Auto-healing consent could not be read for this organization; treating as disabled.",
    };
  }
}

/**
 * Auto-apply gate. Required true (alongside the master gate's true)
 * for the watcher's auto-apply branch to fire. Both pairs being on
 * doesn't bypass the other safety nets — validation, signature
 * stability, budget, and loop breaker still gate the apply.
 */
export async function isAutoApplyAllowed(orgId: string): Promise<AutoHealingConsentResult> {
  if (process.env.JANUSLY_AUTO_HEALING_AUTO_APPLY !== "true") {
    return {
      allowed: false,
      reason: "process_disabled",
      message:
        "Auto-healing auto-apply is disabled at the process level (JANUSLY_AUTO_HEALING_AUTO_APPLY is not 'true').",
    };
  }
  try {
    const snapshot = await getOrgConfigSnapshot(orgId);
    if (!snapshot.autoHealing.autoApply) {
      return {
        allowed: false,
        reason: "tenant_disabled",
        message:
          "Auto-healing auto-apply is not consented for this organization (autoHealing.autoApply is false).",
      };
    }
    return { allowed: true };
  } catch (err) {
    console.warn("[auto-healing] auto-apply consent read failed; fail-closed", { orgId, err });
    return {
      allowed: false,
      reason: "tenant_disabled",
      message:
        "Auto-healing auto-apply consent could not be read; treating as disabled.",
    };
  }
}

/**
 * MCP write consent policy.
 *
 * MCP-issued mutations (`workflows.save` and any future write tool) flow
 * through the same HTTP routes as web mutations, but pass a
 * `x-janusly-source: mcp` header that the auth layer surfaces as
 * `AuthContext.source === "mcp"` in service-token and dev-header modes.
 * Routes that accept MCP writes call `isMcpWriteAllowed(orgId)` BEFORE
 * doing any work; the helper returns true only when BOTH:
 *
 *   1. Process-wide opt-in: `JANUSLY_MCP_WRITES_ENABLED=true` (default
 *      false). Set by the operator at deploy time. A misconfigured tenant
 *      cannot turn this on.
 *   2. Per-tenant opt-in: `org_configs.mcp.writeConsent === true`
 *      (default false). Set per organization by an admin via the standard
 *      org-config API. Tenants that never opted in stay locked even if
 *      the operator flips the env.
 *
 * Either being false returns `{ allowed: false, reason }`; routes turn that
 * into a 403 with a stable `code` so the MCP client can render a clear
 * message.
 *
 * `mcpAuditMetadata` is the canonical tagging helper. Every accepted MCP
 * write merges its result into the route's `audit()` metadata so audit
 * readers can filter on `metadata.source === "mcp"` without a schema
 * change. The `actor` block carries the service-token suffix for
 * forensics (matches the same suffix the auth layer captured).
 *
 * Used by: `apps/api/src/routes/workflows-routes.ts` MCP-write routes (currently
 * `POST /workflows/save`).
 *
 * Invariants:
 * - Multi-tenant scope: the tenant flag is read via `getOrgConfigSnapshot`,
 *   which already filters by `orgId`. There is no cross-tenant escape.
 * - Audit metadata never contains the full service token — only the
 *   trailing 4 chars (`serviceTokenSuffix` from `AuthContext`).
 * - Source header is informational, not authoritative. The gate is the
 *   env + tenant flag pair; an attacker holding the service token cannot
 *   flip either of those by changing the header.
 */

import { getOrgConfigSnapshot } from "@janusly/data/src/orgConfigRepo";
import type { AuthContext } from "./auth";

export type McpWriteAllowedResult =
  | { allowed: true }
  | { allowed: false; reason: "process_disabled" | "tenant_disabled"; message: string };

/**
 * True only when both the process-wide env and the tenant flag are on.
 * Routes accepting MCP writes call this once at the top of the handler
 * after auth resolves; the result drives whether to proceed or to 403.
 */
export async function isMcpWriteAllowed(orgId: string): Promise<McpWriteAllowedResult> {
  if (process.env.JANUSLY_MCP_WRITES_ENABLED !== "true") {
    return {
      allowed: false,
      reason: "process_disabled",
      message: "MCP writes are disabled at the process level (JANUSLY_MCP_WRITES_ENABLED is not 'true').",
    };
  }
  const snapshot = await getOrgConfigSnapshot(orgId);
  if (!snapshot.mcp.writeConsent) {
    return {
      allowed: false,
      reason: "tenant_disabled",
      message: "MCP writes are not consented for this organization (mcp.writeConsent is false).",
    };
  }
  return { allowed: true };
}

/**
 * Tag for audit-log metadata on MCP-source mutations. Spread alongside
 * the route's existing metadata in the `audit()` call so readers can
 * filter `metadata.source === "mcp"`.
 */
export function mcpAuditMetadata(auth: AuthContext): Record<string, unknown> {
  return {
    source: "mcp",
    actor: {
      userId: auth.userId,
      mode: auth.mode,
      serviceTokenSuffix: auth.serviceTokenSuffix,
    },
  };
}

/**
 * Stable per-tool rate-limit bucket name. The route handler passes this
 * to `enforceRateLimit` so the same key forms across replicas. Naming
 * convention: `mcp.<actionKey>` where `<actionKey>` mirrors the MCP tool
 * name (`workflows.save`, `workflows.run`, ...).
 */
export function mcpRateLimitBucket(actionKey: string): string {
  return `mcp.${actionKey}`;
}

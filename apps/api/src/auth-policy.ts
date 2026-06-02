/**
 * Centralized authentication policy evaluator.
 *
 * The auth pipeline has one per-org policy boundary: this module. The
 * membership resolver and the SSO callback both call `evaluateAuthPolicy`
 * instead of inlining gate logic, and the SSO callback reads
 * `sessionTtlSeconds` from the returned decision before issuing a Janusly
 * session token. New auth policy behavior belongs here plus in
 * `getAuthPolicyConfig`'s narrow reader and the org-config catalog — not in
 * individual route handlers.
 *
 * The boot-time dev-headers guard stays where it is — env-level
 * `ALLOW_DEV_AUTH_HEADERS` is the centralized production-time
 * kill-switch, and adding a per-org override would weaken the invariant
 * (an admin could silently re-enable dev-headers for their tenant in
 * production).
 *
 * Mode matrix for the policy gates:
 *
 *   service-token: bypass all (infrastructure callers).
 *   dev-headers:   enforced-SSO only (no email to check domains against).
 *   supabase:      enforced-SSO + allowed-domains + MFA marker.
 *   janusly-session (SSO-issued):
 *     allowed-domains + MFA marker (NOT enforced-SSO — user just
 *     authenticated via SSO; checking it again would reject every SSO
 *     session for an enforced-SSO org).
 *
 * `getAuthPolicyConfig` (in `packages/data/src/orgConfigRepo.ts`) is a
 * narrow `SELECT` for the 3 `auth.*` keys — never the full
 * `OrgConfigSnapshot`. The resolver runs on every authenticated
 * request, so this hot-path budget matters. Storage errors inside that
 * reader degrade to catalog defaults.
 *
 * Used by:
 * - `apps/api/src/auth.ts` (resolver-side policy check).
 * - `apps/api/src/routes/sso-routes.ts` (post-callback policy check +
 *   session TTL from policy).
 *
 * Invariants:
 * - Audit rows for rejected logins go through `audit()` →
 *   `safePersistPayload` (sensitive-key redaction + size cap).
 * - Audit emission is fail-soft — a DB blip cannot prevent the resolver
 *   from returning its decision.
 * - Policy-config storage errors fall through to catalog defaults via
 *   `getAuthPolicyConfig`; SSO-connection read errors are treated as no
 *   active connection.
 */

import {
  getAuthPolicyConfig,
  getSsoConnectionForOrg,
  type SsoConnectionRow,
} from "@janusly/data";

import { audit } from "./audit";
import type { AuthMode } from "./auth";

/**
 * Inputs the resolver and the SSO callback pass in. `mode` drives which
 * gates fire. `email` is `null` for principals that don't carry one
 * (service-token, dev-headers). `ssoConnection` is `null` when the
 * caller hasn't pre-fetched it; the function will read fresh when
 * needed.
 */
export type AuthPolicyInput = {
  orgId: string;
  /** User id of the principal — used as audit row's `userId` actor. */
  userId: string;
  mode: AuthMode;
  email: string | null;
  /**
   * Pre-fetched SSO connection (avoids a redundant DB roundtrip when the
   * resolver has already loaded it). Pass `undefined` to let the
   * evaluator fetch on demand; `null` when there isn't one.
   */
  ssoConnection?: SsoConnectionRow | null;
};

/**
 * Result envelope. `sessionTtlSeconds` is always present so the SSO
 * callback can read it from a single field regardless of the allow/reject
 * outcome (rejected callbacks don't issue tokens, but having the field
 * always-present keeps the shape narrow).
 */
export type AuthPolicyDecision =
  | { allowed: true; sessionTtlSeconds: number }
  | {
      allowed: false;
      reason: string;
      policyKey: string;
      sessionTtlSeconds: number;
    };

/** Policy key constants (mirror catalog and existing schema column names). */
export const POLICY_KEY_ENFORCED_SSO = "sso_connections.enforced_sso" as const;
export const POLICY_KEY_ALLOWED_DOMAINS = "auth.allowedEmailDomains" as const;
export const POLICY_KEY_MFA_REQUIRED = "auth.mfaRequired" as const;

/**
 * Run the org's auth policies against a principal. Returns the decision
 * envelope. On reject, emits an `auth.policy.rejected` audit row.
 *
 * Policy ordering (deterministic — pinned by test):
 *   1. enforced-SSO   (highest specificity; org-level lockdown)
 *   2. allowed-domains
 *   3. MFA marker     (warn-log only; never rejects)
 */
export async function evaluateAuthPolicy(input: AuthPolicyInput): Promise<AuthPolicyDecision> {
  const policy = await getAuthPolicyConfig(input.orgId);
  const sessionTtlSeconds = policy.sessionTtlSeconds;

  // 1. service-token bypass — infrastructure callers.
  if (input.mode === "service-token") {
    return { allowed: true, sessionTtlSeconds };
  }

  // 2. enforced-SSO check. Skips for janusly-session (user just SSO'd)
  //    and for service-token (handled above).
  if (input.mode === "supabase" || input.mode === "dev-headers") {
    const ssoConnection =
      input.ssoConnection === undefined
        ? await safeReadSsoConnection(input.orgId)
        : input.ssoConnection;
    if (ssoConnection && ssoConnection.status === "active" && ssoConnection.enforcedSso) {
      // Explicit escape hatch for local/staging incidents. The gate fires
      // outside production too; without this flag an enforced-SSO org rejects
      // every non-SSO mode even in dev, matching the fail-closed invariant.
      const devBypass = process.env.ALLOW_DEV_SSO_BYPASS === "true";
      if (!devBypass) {
        await safeAudit(input, POLICY_KEY_ENFORCED_SSO, "org requires SSO login");
        return {
          allowed: false,
          reason: "org requires SSO login",
          policyKey: POLICY_KEY_ENFORCED_SSO,
          sessionTtlSeconds,
        };
      }
    }
  }

  // 3. allowed-domains. Fires for human providers that carry an email
  //    (Supabase + SSO session) when a non-empty allow-list is configured.
  //    Missing or malformed email fails closed; dev-headers carries no
  //    email by design and only runs enforced-SSO.
  if (
    policy.allowedEmailDomains.length > 0 &&
    (input.mode === "supabase" || input.mode === "janusly-session")
  ) {
    const domain = input.email?.includes("@")
      ? input.email.toLowerCase().split("@")[1] ?? ""
      : "";
    if (!domain || !policy.allowedEmailDomains.includes(domain)) {
      await safeAudit(
        input,
        POLICY_KEY_ALLOWED_DOMAINS,
        `email domain not in allowed list`,
      );
      return {
        allowed: false,
        reason: "email domain not in allowed list",
        policyKey: POLICY_KEY_ALLOWED_DOMAINS,
        sessionTtlSeconds,
      };
    }
  }

  // 4. MFA marker. Janusly cannot verify MFA from Supabase JWTs or the
  //    current WorkOS profile shape — this is a server-side warning,
  //    not enforcement. UI copy in AuthPolicySettingsPanel
  //    surfaces the marker-only nature.
  if (policy.mfaRequired && (input.mode === "supabase" || input.mode === "janusly-session")) {
    console.warn(
      `[auth-policy] org ${input.orgId} requires MFA but principal (mode=${input.mode}) carries no verifiable MFA claim; allowing because marker is informational only`,
    );
  }

  return { allowed: true, sessionTtlSeconds };
}

async function safeReadSsoConnection(orgId: string): Promise<SsoConnectionRow | null> {
  try {
    return await getSsoConnectionForOrg(orgId);
  } catch (err) {
    console.warn(`[auth-policy] failed to read sso_connections for ${orgId}; treating as no active connection`, err);
    return null;
  }
}

/**
 * Best-effort audit writer. The underlying `audit()` already swallows
 * errors; this wrapper exists so the policy evaluator's audit metadata
 * stays uniform across all three rejection branches.
 */
async function safeAudit(
  input: AuthPolicyInput,
  policyKey: string,
  reason: string,
): Promise<void> {
  await audit(input.orgId, input.userId, "auth.policy.rejected", "user", input.userId, {
    policyKey,
    reason,
    mode: input.mode,
    email: input.email,
  });
}

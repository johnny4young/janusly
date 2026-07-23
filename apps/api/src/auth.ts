/**
 * Request authentication entry point. Three modes, in priority order:
 *   1. **Supabase JWT** — when `Authorization: Bearer <jwt>` is present
 *      and the env carries `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`.
 *   2. **Service token** — when `Authorization: Bearer <token>` matches
 *      `API_SERVICE_TOKEN` via constant-time compare; org/user from
 *      `x-org-id` / `x-user-id` headers (no implicit admin).
 *   3. **Dev headers** — `x-org-id` + `x-user-id`. Allowed automatically
 *      when Supabase is unset and `NODE_ENV !== "production"`. Production
 *      requires explicit `ALLOW_DEV_AUTH_HEADERS=true` or boot fails.
 *
 * Each mode is implemented as a private `extract*` function that produces
 * a `ProviderPrincipal` — the untrusted carrier of provider-supplied
 * claims. `resolveJanuslyMembership` then maps a principal into the final
 * `AuthContext`, whose `orgId` is treated as Janusly-resolved tenant
 * identity by every downstream route. Splitting these two concerns is the
 * seam future work plugs into to swap the org-resolution body (e.g. query
 * `org_members` instead of trusting a JWT claim) and to add new providers
 * (e.g. enterprise SSO) — adding a provider is one new `extract*`
 * function plus one entry in `PROVIDER_CHAIN`.
 *
 * Used by `apps/api/src/server.ts` (the central route dispatcher's
 * `requireAuth(req)` call).
 *
 * Invariants:
 * - Service-token compare uses `timingSafeEqual` (don't replace with `===`).
 * - Supabase JWT requests hardcode `source: "web"` — a browser cannot
 *   self-declare MCP source via `x-janusly-source: mcp`.
 * - Boot fails fast in production without one of the three modes — never
 *   silently fall back to "default" / anonymous.
 * - The Supabase client is constructed once at module load; don't
 *   re-create per request.
 * - Route handlers consume `AuthContext` only — they MUST NOT read
 *   provider-native claim shapes (Supabase `user_metadata.*`, raw
 *   service-token request bodies, etc.) for authorization decisions.
 *   The `ProviderPrincipal` type is intentionally module-private.
 */

import http from "http";
import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

import {
  findPendingInvitation,
  acceptInvitationForIdentity,
  findMemberByEmail,
  getMembershipForOrgUser,
  listMembershipsForUser,
  migrateMemberUserId,
  upsertMembership,
  getSsoConnectionForOrg,
  getActiveAuthSession,
  findVerifiedDomain,
} from "@janusly/data";

import { audit } from "./audit";
import { evaluateAuthPolicy } from "./auth-policy";
import { readBrowserSessionId } from "./browser-session";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

const isProduction = process.env.NODE_ENV === "production";
const explicitDevHeaders = process.env.ALLOW_DEV_AUTH_HEADERS === "true";

if (!supabase && isProduction && !explicitDevHeaders) {
  throw new Error(
    "Production requires Supabase auth (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) or explicit ALLOW_DEV_AUTH_HEADERS=true.",
  );
}

const allowDevHeaders = explicitDevHeaders || (!supabase && !isProduction);

/** Auth mode label — records which provider extracted the request. */
export type AuthMode = "supabase" | "dev-headers" | "service-token" | "janusly-session";

/**
 * Caller surface label. Informational only — never used as an
 * authorization gate. Real consent gates check server-controlled state
 * (env vars + `org_configs`).
 */
export type AuthSource = "web" | "mcp" | "service" | "dev" | "sso";

/** Resolved authentication context handed to each route. */
export type AuthContext = {
  /**
   * Janusly-resolved tenant identity. Routes scope tenancy with
   * `eq(<table>.orgId, auth.orgId)`. Never a raw provider claim —
   * see `resolveJanuslyMembership` for how it is derived from the
   * provider's principal.
   */
  orgId: string;
  /** User identity carried from the provider-stable user id. */
  userId: string;
  /** Which provider extracted this request. */
  mode: AuthMode;
  /**
   * Caller surface label. `"web"` for browser-issued Supabase JWTs,
   * `"mcp"` for MCP clients that self-declared via
   * `x-janusly-source: mcp` in service-token or dev-headers mode,
   * `"service"` for service-token mode without the header, and
   * `"dev"` for dev-headers mode without it.
   *
   * Informational only — used for audit-row tagging and per-tool
   * rate-limit bucketing. NEVER use `source` as an authorization gate;
   * it is set by the caller and is not tamper-proof. Real consent
   * gates (`isMcpWriteAllowed`) check server-controlled state (env
   * var + `org_configs.mcp.writeConsent`).
   */
  source: AuthSource;
  /** Last 4 chars of the service token, when this request authenticated via service-token mode. Audit forensics only. */
  serviceTokenSuffix?: string;
  /** Server-side id of a cookie-authenticated WorkOS session. */
  browserSessionId?: string;
};

/**
 * Provider-verified identity before tenant authorization.
 *
 * Only bootstrap routes may consume this shape. `orgHint` is an untrusted
 * selection preference and MUST NOT be used to scope tenant data; ordinary
 * routes continue receiving `AuthContext` after `org_members` resolution.
 */
export type IdentityContext = {
  userId: string;
  email: string | null;
  mode: AuthMode;
  source: AuthSource;
  orgHint: string | null;
  serviceTokenSuffix?: string;
  /** Server-only revocable session id; never included in API response bodies. */
  browserSessionId?: string;
};

/**
 * Untrusted carrier of provider-supplied claims. Every `extract*`
 * function returns one of these; `resolveJanuslyMembership` then maps
 * it into the final `AuthContext`. Route handlers NEVER see a
 * `ProviderPrincipal` — keeping the type module-private is what keeps
 * provider-native shapes out of downstream code.
 */
type ProviderPrincipal = {
  providerName: AuthMode;
  /** Provider-stable user identifier (e.g. Supabase `user.id`). */
  providerUserId: string;
  /**
   * Provider-supplied user email when the provider carries one (Supabase
   * always does for email-password and SSO flows). `null` for
   * service-token and dev-headers principals — those flows have no email
   * transport and the resolver paths that consume email
   * (invitation-acceptance, verified-domain auto-join) are supabase-only.
   */
  providerUserEmail: string | null;
  /**
   * Untrusted provider-supplied org hint (Supabase JWT
   * `user_metadata.orgId` for the supabase provider; `x-org-id`
   * request header for service-token and dev-headers providers).
   * MUST be resolved through `resolveJanuslyMembership` before
   * becoming `AuthContext.orgId`.
   */
  providerOrgHint: string | null;
  /** Caller-declared surface label — informational only. */
  declaredSource: AuthSource;
  /** Last-4 of the service token when the request authenticated via service-token mode. */
  serviceTokenSuffix?: string;
  browserSessionId?: string;
};

/**
 * Constant-time compare for `Authorization: Bearer <token>` against the
 * configured service token.
 *
 * Invariant: must NOT be replaced with `===` — service-token mode is the
 * privileged path and a timing leak would let an attacker brute-force
 * the token byte-by-byte. The length guard before `timingSafeEqual`
 * exists because the underlying buffer comparison requires equal-length
 * inputs.
 */
function constantTimeBearerMatch(authHeader: string | undefined, expected: string) {
  if (!authHeader || !expected) return false;
  const expectedHeader = `Bearer ${expected}`;
  if (authHeader.length !== expectedHeader.length) return false;
  const a = Buffer.from(authHeader);
  const b = Buffer.from(expectedHeader);
  return timingSafeEqual(a, b);
}

/** SSO state token payload (used by /auth/sso/start ↔ /auth/sso/callback). */
export type SsoStatePayload = {
  orgId: string;
  nonce: string;
  callbackUrl: string;
};

/** Purpose discriminator constant for the one-time callback state token. */
export const SSO_STATE_PURPOSE = "sso_state" as const;

/**
 * Janusly-session provider — reads the HttpOnly cookie issued by the SSO
 * callback, verifies its signed opaque session id, then resolves the active
 * server-side row. Revoked, expired, or missing rows fail closed.
 *
 * Source is hardcoded to `"sso"` — this provider only ever wraps an SSO
 * login.
 *
 * Runs FIRST in `PROVIDER_CHAIN` so a fresh SSO session beats a stale
 * Supabase cookie that the browser might still be carrying.
 */
async function extractJanuslySession(req: http.IncomingMessage): Promise<ProviderPrincipal | null> {
  const sessionId = readBrowserSessionId(req);
  if (!sessionId) return null;
  const session = await getActiveAuthSession(sessionId);
  if (!session) return null;
  return {
    providerName: "janusly-session",
    providerUserId: session.userId,
    providerUserEmail: session.email,
    providerOrgHint: session.orgId,
    declaredSource: "sso",
    browserSessionId: session.id,
  };
}

/**
 * Supabase JWT provider. Decodes the bearer JWT via the Supabase SDK
 * and extracts the user id + the (untrusted) `user_metadata.orgId`
 * claim.
 *
 * Hardcodes `declaredSource: "web"` regardless of any
 * `x-janusly-source` header — a browser request cannot self-declare
 * MCP source. Real MCP traffic comes through service-token mode and
 * passes the `mcp-consent.ts` two-flag gate.
 */
async function extractSupabase(req: http.IncomingMessage): Promise<ProviderPrincipal | null> {
  if (!supabase) return null;
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.replace("Bearer ", "");
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  // The web client now ships `x-org-id` alongside the Bearer (it reads
  // `localStorage["janusly:activeOrg"]` and injects on every request).
  // The legacy Supabase `user_metadata.orgId` claim is no longer
  // authoritative — `resolveJanuslyMembership` queries `org_members` as
  // the canonical source — but we still read it as a backward-compat
  // hint when the web request omits the header.
  const headerHint = req.headers["x-org-id"];
  const claimHint = (data.user.user_metadata?.orgId as string | undefined) ?? null;
  const orgHint = (typeof headerHint === "string" && headerHint.length > 0)
    ? headerHint
    : claimHint;
  const email = typeof data.user.email === "string" && data.user.email.length > 0
    ? data.user.email.toLowerCase()
    : null;
  return {
    providerName: "supabase",
    providerUserId: data.user.id,
    providerUserEmail: email,
    providerOrgHint: orgHint,
    declaredSource: "web",
  };
}

/**
 * Service-token provider. Constant-time compare against
 * `API_SERVICE_TOKEN`. Self-declared `x-janusly-source: mcp` is
 * honored here so MCP writes hit the consent / audit / rate-limit
 * path (`mcp-consent.ts`). Org and user identity come from `x-org-id`
 * / `x-user-id` request headers; missing values resolve to "default"
 * / "service" via `resolveJanuslyMembership` to preserve the existing
 * service-account convention.
 */
async function extractServiceToken(req: http.IncomingMessage): Promise<ProviderPrincipal | null> {
  const serviceToken = process.env.API_SERVICE_TOKEN;
  if (!serviceToken) return null;
  const authHeader = req.headers.authorization;
  if (!constantTimeBearerMatch(authHeader, serviceToken)) return null;
  const declaredSource = (req.headers["x-janusly-source"] as string | undefined)?.toLowerCase();
  const orgHeader = req.headers["x-org-id"] as string | undefined;
  const userHeader = req.headers["x-user-id"] as string | undefined;
  return {
    providerName: "service-token",
    // Empty header collapses to the "service" service-account label.
    providerUserId: userHeader || "service",
    // Service-token flows don't transport an email — provisioning paths
    // (invitations / verified domains) are supabase-only.
    providerUserEmail: null,
    // Empty header collapses to null so `resolveJanuslyMembership` can
    // apply the "default" fallback uniformly.
    providerOrgHint: orgHeader || null,
    declaredSource: declaredSource === "mcp" ? "mcp" : "service",
    serviceTokenSuffix: serviceToken.slice(-4),
  };
}

/**
 * Dev-headers provider. Reads `x-org-id` + `x-user-id` from the
 * request. Gated by the boot-time `allowDevHeaders` flag —
 * automatically allowed when Supabase is unset and
 * `NODE_ENV !== "production"`, otherwise must be explicitly opted in
 * via `ALLOW_DEV_AUTH_HEADERS=true`.
 *
 * The admin auto-grant in `permissions.ts` only triggers in this mode
 * — service-token and Supabase requests never auto-elevate.
 */
async function extractDevHeaders(req: http.IncomingMessage): Promise<ProviderPrincipal | null> {
  if (!allowDevHeaders) return null;
  const orgId = req.headers["x-org-id"] as string | undefined;
  const userId = req.headers["x-user-id"] as string | undefined;
  if (!orgId || !userId) return null;
  const declaredSource = (req.headers["x-janusly-source"] as string | undefined)?.toLowerCase();
  return {
    providerName: "dev-headers",
    providerUserId: userId,
    // Dev-headers carry no email; provisioning paths are supabase-only.
    providerUserEmail: null,
    providerOrgHint: orgId,
    declaredSource: declaredSource === "mcp" ? "mcp" : "dev",
  };
}

/**
 * Map a `ProviderPrincipal` into the Janusly-resolved `{ orgId, mode }`
 * pair, or `null` when nothing legitimate matches. The Supabase branch is
 * the security-relevant one: the provider's `user_metadata.orgId` /
 * `x-org-id` hint is treated as a SCOPE selector (which of my orgs am I
 * working in) — not as authority. The grant is the `org_members` row.
 *
 * Resolution order for a Supabase principal:
 *   1. Direct match: `org_members` row for `(hint, providerUserId)`.
 *   2. Legacy-orphan lazy backfill: if the matching row's `userId` is the
 *      user's email (the placeholder we used before invite-acceptance
 *      shipped), rewrite the `userId` column to the real UUID — preserves
 *      access for users invited before this resolver landed.
 *   3. Hint-less + exactly one membership: silent default to that org.
 *   4. Hint-less + multiple memberships: 401 (force the client to send
 *      `x-org-id`; the web client does this on every request).
 *   5. Provisioning paths (only with hint + email):
 *      a. Pending invitation matching `(orgId, email)` → accept + upsert.
 *      b. Verified-domain match for the email's domain → upsert with the
 *         row's default role.
 *      c. Active SSO connection → return null (the JIT seam a future
 *         enterprise-SSO provider fills in by running its own
 *         provisioning code path before this resolver).
 *   6. Otherwise → null (resolver fails closed; dispatcher returns 401).
 *
 * Service-token and dev-headers preserve their pre-existing semantics:
 * the hint becomes `orgId` directly. Service-token callers still have to
 * be in `org_members` for `requireRole` to grant a role (no implicit
 * admin); dev-headers gets the admin auto-grant via `permissions.ts`.
 */
async function resolveJanuslyMembership(
  principal: ProviderPrincipal,
): Promise<{ orgId: string; mode: AuthMode } | null> {
  const membership = await resolvePrincipalToOrg(principal);
  if (!membership) return null;
  // Centralized policy evaluation. Runs enforced-SSO, allowed-email-domains,
  // and MFA-marker checks behind a single auditable seam. Rejections are
  // logged by the evaluator as `auth.policy.rejected` audit rows. The
  // resolver only cares about the boolean allow/reject — the session-TTL
  // field is consumed downstream by the SSO callback. We pass
  // `ssoConnection: undefined` (not the result of a prefetch) so the
  // evaluator handles the read via its own fail-soft `safeReadSsoConnection`
  // helper — a DB blip on `sso_connections` cannot throw past this
  // resolver boundary and 500 every authenticated request.
  const decision = await evaluateAuthPolicy({
    orgId: membership.orgId,
    userId: principal.providerUserId,
    mode: membership.mode,
    email: principal.providerUserEmail,
  });
  if (!decision.allowed) return null;
  return membership;
}

async function resolvePrincipalToOrg(
  principal: ProviderPrincipal,
): Promise<{ orgId: string; mode: AuthMode } | null> {
  if (principal.providerName === "supabase") {
    return resolveSupabaseMembership(principal);
  }
  if (principal.providerName === "janusly-session") {
    // The SSO callback already upserted the `org_members` row, so the
    // direct-match branch of the Supabase resolver hits step 1 and
    // returns immediately. The `mode` returned by that helper is
    // hardcoded to "supabase" for the supabase branch; remap to
    // "janusly-session" so downstream callers see the right mode.
    const resolved = await resolveSupabaseMembership(principal);
    if (!resolved) return null;
    return { orgId: resolved.orgId, mode: "janusly-session" };
  }
  if (principal.providerName === "service-token") {
    return { orgId: principal.providerOrgHint ?? "default", mode: "service-token" };
  }
  // dev-headers: extractDevHeaders already enforced a non-empty orgId,
  // so providerOrgHint is always a non-empty string here.
  if (!principal.providerOrgHint) return null;
  return { orgId: principal.providerOrgHint, mode: "dev-headers" };
}

/**
 * Resolve the supabase principal through `org_members` → invitations →
 * verified domains → SSO mapping, in that order. Failure-closed: if no
 * path matches, returns `null` and the dispatcher responds 401.
 */
async function resolveSupabaseMembership(
  principal: ProviderPrincipal,
): Promise<{ orgId: string; mode: AuthMode } | null> {
  const userId = principal.providerUserId;
  const email = principal.providerUserEmail;
  const hint = principal.providerOrgHint;

  // 1. Direct match: existing membership row.
  if (hint) {
    const direct = await getMembershipForOrgUser({ orgId: hint, userId });
    if (direct) return { orgId: hint, mode: "supabase" };

    // 2. Legacy-orphan lazy backfill: a previous invite flow seeded
    //    `org_members` rows with `userId = email` as a placeholder. On
    //    the user's first authenticated sign-in, rewrite `userId` to the
    //    real Supabase UUID and accept the row as their membership.
    if (email) {
      const byEmail = await findMemberByEmail({ orgId: hint, email });
      if (byEmail && byEmail.userId !== userId && byEmail.userId.includes("@")) {
        await migrateMemberUserId({ id: byEmail.id, orgId: hint, newUserId: userId });
        await audit(hint, userId, "member.userid.migrated", "member", byEmail.id, {
          from: byEmail.userId,
          to: userId,
        });
        return { orgId: hint, mode: "supabase" };
      }
    }
  }

  // 3 + 4. No hint? Use single membership if unambiguous; 401 on multi.
  if (!hint) {
    const all = await listMembershipsForUser(userId);
    if (all.length === 1) return { orgId: all[0].orgId, mode: "supabase" };
    if (all.length > 1) return null; // ambiguous — force the client to send x-org-id.
    return null; // no memberships and no hint — nothing to resolve.
  }

  // 5. Provisioning paths require an email (Supabase always carries one
  //    for human flows; truly anonymous Supabase sessions skip these).
  if (!email) return null;

  // 5a. Pending invitation acceptance.
  const invite = await findPendingInvitation({ orgId: hint, email });
  if (invite) {
    const accepted = await acceptInvitationForIdentity({
      invitationId: invite.id,
      expectedOrgId: hint,
      userId,
      email,
    });
    if (!accepted.ok) {
      const raced = await getMembershipForOrgUser({ orgId: hint, userId });
      if (raced) return { orgId: hint, mode: "supabase" };
      return null;
    }
    return { orgId: hint, mode: "supabase" };
  }

  // 5b. Verified-domain auto-join.
  const atIdx = email.indexOf("@");
  const domain = atIdx >= 0 ? email.slice(atIdx + 1).toLowerCase() : "";
  if (domain) {
    const verified = await findVerifiedDomain({ orgId: hint, domain });
    if (verified) {
      await upsertMembership({
        orgId: hint,
        userId,
        email,
        role: verified.defaultRole,
      });
      await audit(hint, userId, "member.joined", "member", userId, {
        via: "verified_domain",
        domain,
        email,
      });
      return { orgId: hint, mode: "supabase" };
    }
  }

  // 5c. SSO JIT handoff. An active connection means the org expects
  //     users to arrive via an SSO provider (e.g. WorkOS) — that
  //     provider's extractor runs its own JIT-provisioning before this
  //     resolver. A Supabase principal landing here without a membership
  //     means the SSO flow has NOT run; fail closed.
  const sso = await getSsoConnectionForOrg(hint);
  if (sso && sso.status === "active") return null;

  return null;
}


/**
 * Provider chain in priority order: Janusly SSO session first (so a fresh
 * SSO login beats any stale Supabase cookie), then Supabase JWT, then
 * service-token (MCP-style Bearer beats dev-headers), then dev-headers.
 * The first provider that produces a non-null `ProviderPrincipal` wins;
 * subsequent providers do not run.
 */
const PROVIDER_CHAIN = [
  extractJanuslySession,
  extractSupabase,
  extractServiceToken,
  extractDevHeaders,
] as const;

/** Return the first provider-verified principal without resolving a tenant. */
async function extractProviderPrincipal(req: http.IncomingMessage): Promise<ProviderPrincipal | null> {
  for (const extract of PROVIDER_CHAIN) {
    const principal = await extract(req);
    if (principal) return principal;
  }
  return null;
}

/**
 * Resolve who is calling without asserting organization membership.
 *
 * This is intentionally narrower than `getAuth`: it exists for the session
 * bootstrap and first-organization flow where a legitimate user may have zero
 * memberships. Never use it for tenant-scoped reads or writes.
 */
export async function getIdentity(req: http.IncomingMessage): Promise<IdentityContext | null> {
  const principal = await extractProviderPrincipal(req);
  if (!principal) return null;
  const identity: IdentityContext = {
    userId: principal.providerUserId,
    email: principal.providerUserEmail,
    mode: principal.providerName,
    source: principal.declaredSource,
    orgHint: principal.providerOrgHint,
  };
  if (principal.serviceTokenSuffix !== undefined) {
    identity.serviceTokenSuffix = principal.serviceTokenSuffix;
  }
  if (principal.browserSessionId !== undefined) {
    identity.browserSessionId = principal.browserSessionId;
  }
  return identity;
}

/**
 * Resolve the request's auth context, or `null` when no provider
 * matched. Routes prefer `requireAuth` (which throws 401 on null).
 *
 * The two-step pattern (extract a principal, then resolve membership)
 * keeps provider-native claim shapes out of every downstream caller.
 */
export async function getAuth(req: http.IncomingMessage): Promise<AuthContext | null> {
  const principal = await extractProviderPrincipal(req);
  if (!principal) return null;
  const membership = await resolveJanuslyMembership(principal);
  if (!membership) return null;
  const context: AuthContext = {
    orgId: membership.orgId,
    userId: principal.providerUserId,
    mode: membership.mode,
    source: principal.declaredSource,
  };
  if (principal.serviceTokenSuffix !== undefined) {
    context.serviceTokenSuffix = principal.serviceTokenSuffix;
  }
  if (principal.browserSessionId !== undefined) {
    context.browserSessionId = principal.browserSessionId;
  }
  return context;
}

/** `getIdentity` + throw a 401 without requiring an organization grant. */
export async function requireIdentity(req: http.IncomingMessage): Promise<IdentityContext> {
  const identity = await getIdentity(req);
  if (!identity) {
    const err = new Error("Unauthorized: missing or invalid identity provider") as Error & { statusCode?: number };
    err.statusCode = 401;
    throw err;
  }
  return identity;
}

/** `getAuth` + throw a 401 on null. Every mutating route calls this first. */
export async function requireAuth(req: http.IncomingMessage) {
  const auth = await getAuth(req);

  if (!auth) {
    const err = new Error("Unauthorized: missing Supabase JWT or dev headers") as Error & { statusCode?: number };
    err.statusCode = 401;
    throw err;
  }

  return auth;
}

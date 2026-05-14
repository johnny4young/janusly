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
export type AuthMode = "supabase" | "dev-headers" | "service-token";

/**
 * Caller surface label. Informational only — never used as an
 * authorization gate. Real consent gates check server-controlled state
 * (env vars + `org_configs`).
 */
export type AuthSource = "web" | "mcp" | "service" | "dev";

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
  const orgHint = (data.user.user_metadata?.orgId as string | undefined) ?? null;
  return {
    providerName: "supabase",
    providerUserId: data.user.id,
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
    providerOrgHint: orgId,
    declaredSource: declaredSource === "mcp" ? "mcp" : "dev",
  };
}

/**
 * Map a `ProviderPrincipal` into the Janusly-resolved
 * `{ orgId, mode }` pair. This is the seam future work plugs into when
 * org resolution moves to the `org_members` table (instead of trusting
 * provider-supplied hints).
 *
 * Today's behavior preserves the pre-boundary semantics bit-for-bit:
 *
 * - Supabase: the JWT's `user_metadata.orgId` claim becomes `orgId`,
 *   falling back to `"default"` when the claim is absent. This is an
 *   untrusted-claim path (a user can edit their own `user_metadata`);
 *   the seam exists so the body can be rewritten to query `org_members`
 *   without changing any caller.
 * - Service-token: the `x-org-id` request header becomes `orgId`,
 *   falling back to `"default"` when absent or empty.
 * - Dev-headers: the `x-org-id` request header becomes `orgId` (the
 *   provider already enforced a non-empty value).
 */
async function resolveJanuslyMembership(
  principal: ProviderPrincipal,
): Promise<{ orgId: string; mode: AuthMode } | null> {
  if (principal.providerName === "supabase") {
    return { orgId: principal.providerOrgHint ?? "default", mode: "supabase" };
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
 * Provider chain in priority order: Supabase JWT first, then
 * service-token (so an MCP-style Bearer beats dev-headers), then
 * dev-headers. The first provider that produces a non-null
 * `ProviderPrincipal` wins; subsequent providers do not run.
 */
const PROVIDER_CHAIN = [extractSupabase, extractServiceToken, extractDevHeaders] as const;

/**
 * Resolve the request's auth context, or `null` when no provider
 * matched. Routes prefer `requireAuth` (which throws 401 on null).
 *
 * The two-step pattern (extract a principal, then resolve membership)
 * keeps provider-native claim shapes out of every downstream caller.
 */
export async function getAuth(req: http.IncomingMessage): Promise<AuthContext | null> {
  for (const extract of PROVIDER_CHAIN) {
    const principal = await extract(req);
    if (!principal) continue;
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
    return context;
  }
  return null;
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

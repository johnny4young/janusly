/**
 * Minimal WorkOS REST client. Two operations:
 *
 *   - `buildAuthorizeUrl({ connectionId, redirectUri, state })` — pure URL
 *     build (no I/O); the operator's browser is redirected here on
 *     `/auth/sso/start`.
 *   - `exchangeCode({ code, redirectUri })` — single POST to
 *     `https://api.workos.com/sso/token` that exchanges the WorkOS
 *     authorization code for a profile (and access token, which we do
 *     not store).
 *
 * Why REST instead of `@workos-inc/node`: the SDK is a thin wrapper around
 * `fetch` that would bypass the `fetchHttpTarget` chokepoint in
 * `packages/engine/src/http-policy.ts`. That chokepoint applies SSRF
 * defense, redirect budget, body cap, and timeout — invariants every
 * outbound HTTP call in Janusly goes through. Routing this call through
 * it keeps the surface uniform and avoids an npm dependency for two
 * endpoints.
 *
 * Pinning `WorkOS-Version: 2024-07-01`: WorkOS rotates response shapes
 * per API version; pinning prevents a silent JIT-mapping drift when
 * WorkOS ships a new version.
 *
 * Used by:
 * - `apps/api/src/routes/sso-routes.ts` (`/auth/sso/start` builds the
 *   authorize URL; `/auth/sso/callback` calls `exchangeCode`).
 *
 * Invariants:
 * - `WORKOS_API_KEY` is the only secret; it goes in env, never logged.
 * - Non-2xx responses throw `WorkOsExchangeError` so the route's try
 *   block can emit the standard `auth.sso.callback_failed` audit row
 *   and return 400 without leaking WorkOS-side details to the caller.
 * - `fetchHttpTarget` runs with the default 30s timeout and 1MB body
 *   cap. WorkOS' token-exchange response is small (<2KB).
 */

import { fetchHttpTarget } from "@janusly/engine/src/http-policy";

const WORKOS_AUTHORIZE_URL = "https://api.workos.com/sso/authorize";
const WORKOS_TOKEN_URL = "https://api.workos.com/sso/token";
const WORKOS_API_VERSION = "2024-07-01";

/** Per-deployment client id (WorkOS Dashboard → Configuration → API Keys → Client ID, starts with `client_`). */
function getClientId(): string {
  const value = process.env.WORKOS_CLIENT_ID;
  if (!value) throw new Error("WORKOS_CLIENT_ID is not set");
  return value;
}

/** Per-deployment secret key (WorkOS Dashboard → Configuration → API Keys → Secret Key, starts with `sk_test_` or `sk_live_`). */
function getApiKey(): string {
  const value = process.env.WORKOS_API_KEY;
  if (!value) throw new Error("WORKOS_API_KEY is not set");
  return value;
}

/** Profile shape returned by the WorkOS token-exchange endpoint. */
export type WorkOsProfile = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  connectionId: string;
  organizationId: string | null;
};

export class WorkOsExchangeError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "WorkOsExchangeError";
    this.statusCode = statusCode;
  }
}

/**
 * Build the WorkOS authorization URL the browser is redirected to. WorkOS
 * uses the `connection` query param to scope the auth to a specific
 * configured connection (the same `conn_…` id stored in
 * `sso_connections.providerConnectionId`).
 */
export function buildAuthorizeUrl(input: {
  connectionId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(WORKOS_AUTHORIZE_URL);
  url.searchParams.set("client_id", getClientId());
  url.searchParams.set("connection", input.connectionId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", input.state);
  return url.toString();
}

/**
 * Exchange a WorkOS authorization `code` for a `WorkOsProfile`. Called
 * inside the `/auth/sso/callback` handler. The returned profile carries
 * `connectionId` which the caller MUST verify against
 * `sso_connections.providerConnectionId` for the resolved org — that's
 * the org-binding check (defense against an attacker who'd otherwise try
 * to use a code issued for org A to log in to org B).
 */
export async function exchangeCode(input: {
  code: string;
  redirectUri: string;
}): Promise<WorkOsProfile> {
  const body = new URLSearchParams({
    client_id: getClientId(),
    client_secret: getApiKey(),
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
  });

  const result = await fetchHttpTarget(WORKOS_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "WorkOS-Version": WORKOS_API_VERSION,
      Accept: "application/json",
    },
    body: body.toString(),
  });

  if (!result.ok) {
    throw new WorkOsExchangeError(
      `WorkOS token exchange failed with status ${result.statusCode}`,
      result.statusCode,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.body);
  } catch {
    throw new WorkOsExchangeError("WorkOS token exchange returned non-JSON body", result.statusCode);
  }

  const profile = readProfile(parsed);
  if (!profile) {
    throw new WorkOsExchangeError(
      "WorkOS token exchange response missing profile fields",
      result.statusCode,
    );
  }
  return profile;
}

/** Defensive reader — WorkOS' response carries the profile under `.profile`. */
function readProfile(raw: unknown): WorkOsProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const wrapper = raw as { profile?: unknown };
  const source = wrapper.profile;
  if (!source || typeof source !== "object") return null;
  const obj = source as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id : null;
  const email = typeof obj.email === "string" ? obj.email.toLowerCase() : null;
  const connectionId = typeof obj.connection_id === "string" ? obj.connection_id : null;
  if (!id || !email || !connectionId) return null;
  return {
    id,
    email,
    firstName: typeof obj.first_name === "string" ? obj.first_name : null,
    lastName: typeof obj.last_name === "string" ? obj.last_name : null,
    connectionId,
    organizationId: typeof obj.organization_id === "string" ? obj.organization_id : null,
  };
}

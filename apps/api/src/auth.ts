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
 * Used by `apps/api/src/server.ts` (the central route dispatcher's `requireAuth(req)` call).
 *
 * Invariants:
 * - Service-token compare uses `timingSafeEqual` (don't replace with `===`).
 * - Boot fails fast in production without one of the three modes — never
 *   silently fall back to "default" / anonymous.
 * - The Supabase client is constructed once at module load; don't
 *   re-create per request.
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

/** Resolved authentication context handed to each route. `mode` records which auth path matched. */
export type AuthContext = {
  orgId: string;
  userId: string;
  mode: "supabase" | "dev-headers" | "service-token";
  /**
   * Caller surface label. `"web"` when a browser-issued Supabase JWT
   * landed, `"mcp"` when an MCP client identified itself via the
   * `x-janusly-source: mcp` header in service-token or dev-headers
   * mode, `"service"` when service-token mode was used without that
   * header, and `"dev"` when dev headers were used without it.
   *
   * Informational only — used for audit-row tagging and per-tool rate
   * limit bucketing. NEVER use `source` as an authorization gate; it
   * is set by the caller and is not tamper-proof. Real consent gates
   * (`isMcpWriteAllowed`) check server-controlled state (env var +
   * `org_configs.mcp.writeConsent`).
   */
  source: "web" | "mcp" | "service" | "dev";
  /** Last 4 chars of the service token, when this request authenticated via service-token mode. Used for audit forensics. */
  serviceTokenSuffix?: string;
};

function constantTimeBearerMatch(authHeader: string | undefined, expected: string) {
  if (!authHeader || !expected) return false;
  const expectedHeader = `Bearer ${expected}`;
  if (authHeader.length !== expectedHeader.length) return false;
  const a = Buffer.from(authHeader);
  const b = Buffer.from(expectedHeader);
  return timingSafeEqual(a, b);
}

/**
 * Resolve the request's auth context, or `null` when no mode matched.
 * Routes prefer `requireAuth` (which throws 401 on null).
 */
export async function getAuth(req: http.IncomingMessage): Promise<AuthContext | null> {
  const authHeader = req.headers.authorization;

  if (supabase && authHeader?.startsWith("Bearer ")) {
    const token = authHeader.replace("Bearer ", "");
    const { data, error } = await supabase.auth.getUser(token);

    if (!error && data?.user) {
      return {
        orgId: (data.user.user_metadata?.orgId as string | undefined) ?? "default",
        userId: data.user.id,
        mode: "supabase",
        source: "web",
      };
    }
  }

  const serviceToken = process.env.API_SERVICE_TOKEN;

  if (serviceToken && constantTimeBearerMatch(authHeader, serviceToken)) {
    // `x-janusly-source: mcp` is the MCP client's self-declared label.
    // Service-token and dev-header modes preserve it so MCP writes hit
    // the consent / audit / rate-limit path. Supabase JWT requests ignore
    // it so a browser request can't claim MCP source.
    const declaredSource = (req.headers["x-janusly-source"] as string | undefined)?.toLowerCase();
    const source: AuthContext["source"] = declaredSource === "mcp" ? "mcp" : "service";
    return {
      orgId: (req.headers["x-org-id"] as string) || "default",
      userId: (req.headers["x-user-id"] as string) || "service",
      mode: "service-token",
      source,
      serviceTokenSuffix: serviceToken.slice(-4),
    };
  }

  if (!allowDevHeaders) return null;

  const orgId = req.headers["x-org-id"] as string | undefined;
  const userId = req.headers["x-user-id"] as string | undefined;

  if (!orgId || !userId) return null;

  const declaredSource = (req.headers["x-janusly-source"] as string | undefined)?.toLowerCase();
  const source: AuthContext["source"] = declaredSource === "mcp" ? "mcp" : "dev";
  return { orgId, userId, mode: "dev-headers", source };
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

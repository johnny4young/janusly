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
 * Used by `apps/api/src/index.ts` (every route's `requireAuth(req)` call).
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
      };
    }
  }

  const serviceToken = process.env.API_SERVICE_TOKEN;

  if (serviceToken && constantTimeBearerMatch(authHeader, serviceToken)) {
    return {
      orgId: (req.headers["x-org-id"] as string) || "default",
      userId: (req.headers["x-user-id"] as string) || "service",
      mode: "service-token",
    };
  }

  if (!allowDevHeaders) return null;

  const orgId = req.headers["x-org-id"] as string | undefined;
  const userId = req.headers["x-user-id"] as string | undefined;

  if (!orgId || !userId) return null;

  return { orgId, userId, mode: "dev-headers" };
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

import http from "http";
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

export type AuthContext = {
  orgId: string;
  userId: string;
  mode: "supabase" | "dev-headers" | "service-token";
};

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

  if (serviceToken && authHeader === `Bearer ${serviceToken}`) {
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

export async function requireAuth(req: http.IncomingMessage) {
  const auth = await getAuth(req);

  if (!auth) {
    const err = new Error("Unauthorized: missing Supabase JWT or dev headers") as Error & { statusCode?: number };
    err.statusCode = 401;
    throw err;
  }

  return auth;
}

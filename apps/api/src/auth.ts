import http from "http";

export type AuthContext = {
  orgId: string;
  userId: string;
  mode: "dev-headers" | "service-token";
};

export function getAuth(req: http.IncomingMessage): AuthContext | null {
  const serviceToken = process.env.API_SERVICE_TOKEN;
  const authHeader = req.headers.authorization;

  if (serviceToken && authHeader === `Bearer ${serviceToken}`) {
    return {
      orgId: (req.headers["x-org-id"] as string) || "default",
      userId: (req.headers["x-user-id"] as string) || "service",
      mode: "service-token",
    };
  }

  const orgId = req.headers["x-org-id"] as string | undefined;
  const userId = req.headers["x-user-id"] as string | undefined;

  if (!orgId || !userId) {
    return null;
  }

  return {
    orgId,
    userId,
    mode: "dev-headers",
  };
}

export function requireAuth(req: http.IncomingMessage) {
  const auth = getAuth(req);

  if (!auth) {
    const err = new Error("Unauthorized: missing x-org-id/x-user-id or valid service token");
    (err as any).statusCode = 401;
    throw err;
  }

  return auth;
}

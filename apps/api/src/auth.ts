import http from "http";
import { createClerkClient } from "@clerk/backend";

const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
});

export type AuthContext = {
  orgId: string;
  userId: string;
  mode: "clerk" | "dev-headers" | "service-token";
};

export async function getAuth(req: http.IncomingMessage): Promise<AuthContext | null> {
  const authHeader = req.headers.authorization;

  if (authHeader?.startsWith("Bearer ") && process.env.CLERK_SECRET_KEY) {
    try {
      const request = new Request("http://localhost", {
        headers: { Authorization: authHeader },
      });

      const requestState = await clerk.authenticateRequest(request);

      if (requestState.isAuthenticated) {
        const auth = requestState.toAuth();

        return {
          orgId: auth.orgId || "default",
          userId: auth.userId || "unknown",
          mode: "clerk",
        };
      }
    } catch (err) {
      console.error("Clerk auth failed", err);
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

  const orgId = req.headers["x-org-id"] as string | undefined;
  const userId = req.headers["x-user-id"] as string | undefined;

  if (!orgId || !userId) {
    return null;
  }

  return { orgId, userId, mode: "dev-headers" };
}

export async function requireAuth(req: http.IncomingMessage) {
  const auth = await getAuth(req);

  if (!auth) {
    const err = new Error("Unauthorized: missing Clerk JWT, service token, or x-org-id/x-user-id");
    (err as any).statusCode = 401;
    throw err;
  }

  return auth;
}

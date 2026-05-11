/**
 * HTTP server construction for the Janusly API.
 *
 * Used by:
 * - apps/api/src/index.ts to boot the production/dev API process.
 * - apps/api/src/server.test.ts to validate request dispatch and runtime guards.
 *
 * Invariants:
 * - CORS preflight handling stays auth-free.
 * - Route auth and role checks are enforced before handlers run.
 * - Node HTTP timeouts are set explicitly so slow clients cannot pin sockets forever.
 */
import http from "http";

import { requireAuth, type AuthContext } from "./auth";
import { corsHeaders, sendJson, type CorsAwareResponse } from "./http";
import { requireRole } from "./permissions";
import { matchesRoute, type Route } from "./routes";

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 5_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 65_000;
const MIN_HEADERS_TIMEOUT_DELTA_MS = 1_000;

export type ApiServerTimeouts = {
  requestTimeoutMs?: number;
  keepAliveTimeoutMs?: number;
  headersTimeoutMs?: number;
};

export type CreateApiServerOptions = {
  routes: readonly Route[];
  timeouts?: ApiServerTimeouts;
};

export function createApiServer({
  routes,
  timeouts,
}: CreateApiServerOptions): http.Server {
  const server = http.createServer(async (req, res) => {
    await dispatchRequest(routes, req, res);
  });

  configureApiServerTimeouts(server, timeouts);
  return server;
}

export function configureApiServerTimeouts(
  server: http.Server,
  timeouts: ApiServerTimeouts = {},
): void {
  const requestTimeoutMs = normalizeTimeout(
    timeouts.requestTimeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  const keepAliveTimeoutMs = normalizeTimeout(
    timeouts.keepAliveTimeoutMs,
    DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
  );
  const requestedHeadersTimeoutMs = normalizeTimeout(
    timeouts.headersTimeoutMs,
    DEFAULT_HEADERS_TIMEOUT_MS,
  );
  const headersTimeoutMs = Math.max(
    requestedHeadersTimeoutMs,
    keepAliveTimeoutMs + MIN_HEADERS_TIMEOUT_DELTA_MS,
  );

  server.requestTimeout = requestTimeoutMs;
  server.setTimeout(requestTimeoutMs);
  server.keepAliveTimeout = keepAliveTimeoutMs;
  server.headersTimeout = headersTimeoutMs;
}

async function dispatchRequest(
  routes: readonly Route[],
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const response = res as CorsAwareResponse;
  response.requestOrigin = Array.isArray(req.headers.origin)
    ? req.headers.origin[0]
    : req.headers.origin;

  if (req.method === "OPTIONS") {
    const headers = corsHeaders(response);
    res.writeHead(204, headers);
    res.end();
    return;
  }

  try {
    const url = req.url ?? "";
    const matched = routes.find((route) => {
      return route.method === req.method && matchesRoute(route.match, url);
    });

    if (!matched) {
      sendJson(response, { error: "Not found" }, 404);
      return;
    }

    let auth: AuthContext;
    if (matched.skipAuth) {
      auth = { orgId: "", userId: "", mode: "dev-headers" };
    } else {
      auth = await requireAuth(req);
      if (matched.role) {
        await requireRole(auth.orgId, auth.userId, matched.role, auth.mode);
      }
    }

    await matched.handler({ req, res: response, auth });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Server error";
    const statusCode = resolveErrorStatusCode(err);
    sendJson(response, { error: message }, statusCode);
  }
}

function normalizeTimeout(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) {
    return fallback;
  }
  return Math.trunc(value);
}

function resolveErrorStatusCode(err: unknown): number {
  if (!err || typeof err !== "object" || !("statusCode" in err)) {
    return 500;
  }

  const statusCode = Number((err as { statusCode?: unknown }).statusCode);
  if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600) {
    return statusCode;
  }

  return 500;
}

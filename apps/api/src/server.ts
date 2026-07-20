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
import { randomUUID } from "node:crypto";

import { requireAuth, type AuthContext } from "./auth";
import { corsHeaders, sendError, type CorsAwareResponse } from "./http";
import { requirePermission, requireRole } from "./permissions";
import { matchesRoute, type Route } from "./routes";

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 5_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 65_000;
const MIN_HEADERS_TIMEOUT_DELTA_MS = 1_000;
const VERSION_PREFIX = "/v1";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

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
  // Stash the negotiated encoding so `sendJson` can decide whether to gzip.
  const acceptEncoding = req.headers["accept-encoding"];
  response.requestAcceptEncoding = Array.isArray(acceptEncoding)
    ? acceptEncoding.join(", ")
    : acceptEncoding;
  response.requestId = resolveRequestId(req.headers["x-request-id"]);

  if (req.method === "OPTIONS") {
    const headers = corsHeaders(response);
    res.writeHead(204, headers);
    res.end();
    return;
  }

  try {
    const url = req.url ?? "";
    let matched = routes.find((route) => {
      return route.method === req.method && matchesRoute(route.match, url);
    });
    let handlerUrl = url;
    let versionedAlias = false;

    // Exact routes win first so `/v1/openapi.json` can be a real public route
    // without receiving the normal data envelope. Every other `/v1/*` path is
    // an alias of a legacy route and resolves only when that route declares a
    // contract. This makes accidental API exposure fail closed.
    if (!matched && isVersionedAliasUrl(url)) {
      const legacyUrl = url.slice(VERSION_PREFIX.length) || "/";
      const candidate = routes.find((route) => {
        return route.method === req.method &&
          route.contract !== undefined &&
          matchesContractPath(route.contract.path, legacyUrl) &&
          matchesRoute(route.match, legacyUrl);
      });
      response.apiVersion = "v1";
      if (candidate?.contract) {
        matched = candidate;
        handlerUrl = legacyUrl;
        versionedAlias = true;
        response.contract = candidate.contract;
      }
    }

    if (!matched) {
      sendError(response, "server_not_found", "Not found", 404);
      return;
    }

    let auth: AuthContext;
    if (matched.skipAuth) {
      auth = { orgId: "", userId: "", mode: "dev-headers", source: "dev" };
    } else {
      auth = await requireAuth(req);
      if (matched.role) {
        await requireRole(auth.orgId, auth.userId, matched.role, auth.mode);
      }
      if (matched.permission) {
        await requirePermission(auth.orgId, auth.userId, matched.permission, auth.mode);
      }
    }

    if (versionedAlias && matched.contract?.request?.query) {
      const query = parseContractQuery(handlerUrl, matched.contract.request.repeatableQueryParams);
      const result = matched.contract.request.query.safeParse(query);
      if (!result.success) {
        const field = result.error.issues[0]?.path.join(".") || "query";
        sendError(response, "invalid_input", "Invalid request query", 400, { field });
        return;
      }
    }

    req.url = handlerUrl;
    await matched.handler({ req, res: response, auth });
  } catch (err) {
    const statusCode = resolveErrorStatusCode(err);
    if (statusCode === null) {
      // Unexpected throw — no `statusCode` contract means nobody curated this
      // message for clients. Echoing it would leak internals (DB hosts,
      // driver errors, stack fragments), and until now nothing logged it
      // server-side either, so unexpected 500s were both leaky AND silent.
      // Keep the response generic and put the real error in the server log.
      console.error("[api] unhandled route error", {
        method: req.method,
        url: req.url,
        err,
      });
      sendError(response, "server_internal_error", "Server error", 500);
      return;
    }
    // Deliberate HTTP error (`httpError(message, status)` and friends) — the
    // message is operator-curated and client-facing by design.
    const message = err instanceof Error ? err.message : "Server error";
    sendError(response, "server_request_failed", message, statusCode);
  }
}

/** Keep caller-supplied correlation IDs when safe; otherwise mint a UUID. */
export function resolveRequestId(value: string | string[] | undefined): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && REQUEST_ID_PATTERN.test(candidate) ? candidate : randomUUID();
}

function isVersionedAliasUrl(url: string): boolean {
  return url === VERSION_PREFIX || url.startsWith(`${VERSION_PREFIX}/`);
}

/**
 * Match an OpenAPI path template against the URL pathname. Requiring both this
 * and the legacy route matcher prevents broad `startsWith` handlers from
 * exposing undeclared aliases such as `/v1/workflows-extra`.
 */
export function matchesContractPath(contractPath: string, url: string): boolean {
  const actualSegments = new URL(url, "http://localhost").pathname.split("/").filter(Boolean);
  const contractSegments = contractPath.split("/").filter(Boolean);
  if (actualSegments.length !== contractSegments.length) return false;
  return contractSegments.every((segment, index) => {
    return /^\{[^{}]+\}$/.test(segment) || segment === actualSegments[index];
  });
}

/** Convert URLSearchParams into the raw object a route's Zod query schema expects. */
function parseContractQuery(
  url: string,
  repeatableKeys: readonly string[] = [],
): Record<string, string | string[]> {
  const searchParams = new URL(url, "http://localhost").searchParams;
  const repeatable = new Set(repeatableKeys);
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(searchParams.keys())) {
    const values = searchParams.getAll(key);
    query[key] = repeatable.has(key) || values.length > 1 ? values : (values[0] ?? "");
  }
  return query;
}

function normalizeTimeout(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) {
    return fallback;
  }
  return Math.trunc(value);
}

/**
 * Extract a deliberate HTTP status from a thrown error. Returns the status
 * when the error carries a valid `statusCode` field in `[400, 600)` — the
 * `httpError(message, status)` contract — and `null` for anything else
 * (plain throws, driver errors, bugs). The dispatcher treats `null` as
 * "unexpected": generic client response + server-side log, never the raw
 * message.
 */
function resolveErrorStatusCode(err: unknown): number | null {
  if (!err || typeof err !== "object" || !("statusCode" in err)) {
    return null;
  }

  const statusCode = Number((err as { statusCode?: unknown }).statusCode);
  if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600) {
    return statusCode;
  }

  return null;
}

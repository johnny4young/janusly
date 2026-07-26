/**
 * Auth-aware HTTP client for the Janusly API.
 *
 * The MCP server is intentionally a proxy: every tool call becomes a single
 * HTTP request against the running `apps/api` server. This module owns
 * (a) resolving the connection config from environment variables and (b) the
 * thin `fetch` wrapper that injects auth headers, validates `/v1` envelopes,
 * and surfaces useful errors back to the MCP dispatcher.
 *
 * Used by:
 * - `packages/mcp-server/src/index.ts` — boot path constructs the client.
 * - `packages/mcp-server/src/tools.ts` — `dispatchTool` calls the closure
 *   returned by `createApiClient`.
 *
 * Invariants:
 * - The MCP server never queries the DB directly. Multi-tenant scope, audit
 *   logs, rate limits — all already enforced by the API. Don't add a Drizzle
 *   import to this package.
 * - Empty-string `JANUSLY_API_SERVICE_TOKEN` is treated as unset (`""` from a
 *   `KEY=` line in `.env` shouldn't send `Authorization: Bearer `).
 */

/** Resolved connection config for the Janusly API. */
export type ApiClientConfig = {
  apiUrl: string;
  orgId: string;
  userId: string;
  serviceToken?: string;
};

/**
 * Read the four environment variables that drive the MCP server's auth
 * context, returning a fully-defaulted `ApiClientConfig`. Pure over `env` so
 * tests can pass a fake `process.env` without touching the real one.
 *
 * Defaults are tuned for a local `pnpm dev` story: localhost API, the
 * `default` org, and a `mcp-user` user-id that distinguishes MCP traffic
 * from web traffic in audit logs.
 */
export function resolveApiClientConfig(env: NodeJS.ProcessEnv): ApiClientConfig {
  return {
    apiUrl: (env.JANUSLY_API_URL ?? "http://127.0.0.1:3001").replace(/\/+$/, ""),
    orgId: env.JANUSLY_API_ORG_ID ?? "default",
    userId: env.JANUSLY_API_USER_ID ?? "mcp-user",
    serviceToken: env.JANUSLY_API_SERVICE_TOKEN || undefined,
  };
}

/** Bound HTTP closure handed to `dispatchTool`; returns normalized operation data or throws. */
export type CallApi = (path: string, init?: RequestInit) => Promise<unknown>;

/** Catalogued HTTP failure returned by the stable API lane. */
export class JanuslyApiError extends Error {
  override readonly name = "JanuslyApiError";

  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
    readonly requestId: string | undefined,
    readonly path: string,
    readonly params: Record<string, string | number | boolean> | undefined,
  ) {
    super(message);
  }
}

/** Successful HTTP response that violates the advertised v1 envelope. */
export class JanuslyProtocolError extends Error {
  override readonly name = "JanuslyProtocolError";
}

/**
 * Build a `callApi(path)` closure bound to one config. Each call injects
 * `x-org-id` / `x-user-id` and (when configured) an `Authorization: Bearer`
 * service token. Stable successes are unwrapped after protocol validation;
 * non-2xx responses preserve catalogued v1 codes and request IDs when present.
 */
export function createApiClient(cfg: ApiClientConfig): CallApi {
  const apiUrl = cfg.apiUrl.replace(/\/+$/, "");
  return async function callApi(path: string, init: RequestInit = {}): Promise<unknown> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-org-id": cfg.orgId,
      "x-user-id": cfg.userId,
      // Self-declared source label. The API honors this only in
      // service-token mode (see `apps/api/src/auth.ts`). It's used for
      // audit tagging and per-tool rate-limit bucketing on the API
      // side, never as an authorization gate (those gates check env
      // and `org_configs.mcp.writeConsent`).
      "x-janusly-source": "mcp",
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    };
    if (cfg.serviceToken) headers.authorization = `Bearer ${cfg.serviceToken}`;

    const res = await fetch(`${apiUrl}${path}`, { ...init, headers });
    const text = await res.text().catch(() => "");
    const payload = parseJson(text);
    if (!res.ok) {
      const stableError = readStableError(payload);
      const detail = stableError?.message ?? (text ? text.slice(0, 256) : res.statusText);
      throw new JanuslyApiError(
        `Janusly API ${res.status} on ${path}: ${detail}`,
        res.status,
        stableError?.code,
        stableError?.requestId,
        path,
        stableError?.params,
      );
    }
    if (path === "/v1" || path.startsWith("/v1/")) {
      return unwrapStableSuccess(payload, path);
    }
    if (payload === undefined) {
      throw new JanuslyProtocolError(`Janusly API returned non-JSON success on ${path}`);
    }
    return payload;
  };
}

function parseJson(text: string): unknown | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function unwrapStableSuccess(payload: unknown, path: string): unknown {
  if (
    !isRecord(payload)
    || payload.apiVersion !== "v1"
    || typeof payload.requestId !== "string"
    || !("data" in payload)
  ) {
    throw new JanuslyProtocolError(`Janusly API returned an invalid v1 success envelope on ${path}`);
  }
  return payload.data;
}

function readStableError(payload: unknown): {
  code: string;
  message: string;
  requestId: string | undefined;
  params: Record<string, string | number | boolean> | undefined;
} | null {
  if (!isRecord(payload) || !isRecord(payload.error)) return null;
  const code = payload.error.code;
  const message = payload.error.message;
  if (typeof code !== "string" || typeof message !== "string") return null;
  return {
    code,
    message,
    requestId: typeof payload.requestId === "string" ? payload.requestId : undefined,
    params: readErrorParams(payload.error.params),
  };
}

function readErrorParams(value: unknown): Record<string, string | number | boolean> | undefined {
  if (!isRecord(value)) return undefined;
  const params: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      params[key] = item;
    }
  }
  return Object.keys(params).length > 0 ? params : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Auth-aware HTTP client for the Janusly API.
 *
 * The MCP server is intentionally a proxy: every tool call becomes a single
 * HTTP request against the running `apps/api` server. This module owns
 * (a) resolving the connection config from environment variables and (b) the
 * thin `fetch` wrapper that injects auth headers and surfaces useful errors
 * back to the MCP dispatcher.
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

/** Bound HTTP closure handed to `dispatchTool`; returns the parsed JSON body or throws. */
export type CallApi = (path: string, init?: RequestInit) => Promise<unknown>;

/**
 * Build a `callApi(path)` closure bound to one config. Each call injects
 * `x-org-id` / `x-user-id` and (when configured) an `Authorization: Bearer`
 * service token. Non-2xx responses throw with status + path + truncated body
 * so Claude Desktop's stderr surfaces a useful diagnostic.
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
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const tail = body ? `: ${body.slice(0, 256)}` : "";
      throw new Error(`Janusly API ${res.status} ${res.statusText} on ${path}${tail}`);
    }
    return res.json();
  };
}

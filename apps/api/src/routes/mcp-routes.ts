/**
 * MCP client connection admin CRUD + tool-descriptor management.
 *
 * Surfaces (admin role + `mcp.connections.write` permission for
 * mutating routes; viewer + `mcp.connections.read` for reads):
 *  - `GET /mcp/connections` — list every connection for the org.
 *  - `POST /mcp/connections` — register a new connection. Validates
 *    alias regex, transport-shape, and (for stdio) the command
 *    allowlist. Immediately runs discovery; persists descriptors with
 *    `enabled: false` and flips status to `active` on success or
 *    `failed` with `statusReason` on error.
 *  - `POST /mcp/connections/:alias` — update enabled flag / envRefs /
 *    args / url / command / exposeToAi. Idempotent.
 *  - `DELETE /mcp/connections/:alias` — cascade-delete descriptors
 *    then the connection row.
 *  - `POST /mcp/connections/:alias/rediscover` — re-runs the
 *    discovery flow, upserting descriptors (existing `enabled` flags
 *    survive).
 *  - `GET /mcp/connections/:alias/tools` — list cached descriptors.
 *  - `POST /mcp/connections/:alias/tools/:toolName` — flip the
 *    operator-controlled flags (enabled, writeSide, rateLimitPerMin).
 *
 * Multi-tenant scope on every read/write. Nine audit actions:
 * `mcp.connection.created` / `_updated` / `_deleted` / `_rediscovered`,
 * `mcp.connection.expose_to_ai_set`, `mcp.tool.enabled` /
 * `mcp.tool.disabled` / `mcp.tool.rate_limit_set` /
 * `mcp.tool.expose_to_ai_set`.
 */

import { audit } from "../audit";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { errorEnvelope } from "../error-codes";
import { asRecord, readJson, sendJson } from "../http";
import {
  createConnection,
  deleteConnection,
  getConnectionByAlias,
  getToolDescriptor,
  listConnections,
  listToolDescriptors,
  setConnectionStatus,
  setToolFlags,
  updateConnection,
  upsertToolDescriptor,
  type McpConnectionRow,
  type McpEnvRefs,
  type McpTransport,
} from "@janusly/data/src/mcpConnectionsRepo";
import {
  createHttpMcpClient,
  createSseMcpClient,
  createStdioMcpClient,
  withMcpClient,
  type McpClient,
} from "@janusly/engine/src/mcp-client";
import { resolveStdioSandboxConfig } from "@janusly/engine/src/mcp-tool-executor";
import { getOrgConfigSnapshot } from "@janusly/data/src/orgConfigRepo";
import { scrubSecretShapes } from "@janusly/shared/src/error-signature";
import { enforceRateLimit } from "../rate-limit";
import type { Route } from "../routes";

const ALIAS_PATTERN = /^[a-z0-9_-]{1,32}$/;
const TRANSPORTS = new Set<McpTransport>(["stdio", "sse", "http"]);
const MAX_DISCOVERY_TOOLS = 200;

function isValidAlias(value: unknown): value is string {
  return typeof value === "string" && ALIAS_PATTERN.test(value);
}

function parseEnvRefsBody(value: unknown): McpEnvRefs {
  const out: McpEnvRefs = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!ALIAS_PATTERN.test(key) && !/^[A-Z][A-Z0-9_]{0,63}$/.test(key)) continue;
    if (!raw || typeof raw !== "object") continue;
    const ref = raw as Record<string, unknown>;
    if (ref.kind !== "env" || typeof ref.name !== "string") continue;
    const name = ref.name.trim();
    if (name.length === 0 || name.length > 128) continue;
    out[key] = { kind: "env", name };
  }
  return out;
}

function parseArgsBody(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v === "string" && v.length > 0) out.push(v.slice(0, 200));
  }
  return out.slice(0, 32);
}

function parseAllowlist(raw: string): string[] {
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

async function resolveCommandAllowlist(orgId: string): Promise<string[]> {
  // Tenant override wins when non-empty; otherwise fall back to env.
  const snapshot = await getOrgConfigSnapshot(orgId);
  const allowlist = parseAllowlist(snapshot.mcp.clientCommandAllowlist);
  if (allowlist.length === 0) {
    return parseAllowlist(process.env.JANUSLY_MCP_ALLOWED_COMMANDS ?? "");
  }
  return allowlist;
}

function buildDiscoveryClient(
  connection: McpConnectionRow,
  stdioSandbox: ReturnType<typeof resolveStdioSandboxConfig>,
): McpClient | Promise<McpClient> {
  // Resolve env-refs once for the discovery hop. Missing env-refs
  // surface a GENERIC error at discovery time too — never echo the
  // env-var name. Same posture as the executor's resolution path so
  // operators get consistent behaviour at discovery and at runtime.
  // CR/LF values are rejected to prevent header injection through the
  // URL-shaped transports (sse + http) — operator-supplied env values
  // flow to remote servers as HTTP headers for both.
  const env: Record<string, string> = {};
  for (const [key, ref] of Object.entries(connection.envRefs)) {
    if (ref.kind !== "env") continue;
    const value = process.env[ref.name];
    if (value === undefined || value === "") {
      throw new Error(`credential secret missing for ${key}`);
    }
    if (/[\r\n]/.test(value)) {
      throw new Error(`credential value invalid for ${key}`);
    }
    env[key] = value;
  }
  if (connection.transport === "stdio") {
    if (!connection.command) throw new Error("stdio connection missing command");
    return createStdioMcpClient({
      command: connection.command,
      args: connection.args ?? [],
      env,
      sandbox: stdioSandbox,
    });
  }
  if (connection.transport === "sse") {
    if (!connection.url) throw new Error("sse connection missing url");
    return createSseMcpClient({ url: connection.url, headers: env });
  }
  if (connection.transport === "http") {
    if (!connection.url) throw new Error("http connection missing url");
    // Streamable HTTP shares the SSRF + headers contract with sse.
    // The only difference is the SDK transport class wrapping the wire.
    return createHttpMcpClient({ url: connection.url, headers: env });
  }
  throw new Error(`unknown mcp transport: ${connection.transport}`);
}

async function runDiscovery(connection: McpConnectionRow): Promise<{ ok: true; tools: number } | { ok: false; error: string }> {
  try {
    // Resolve the spawn-time sandbox config from the org snapshot. The
    // stdio branch of buildDiscoveryClient applies the allowlist re-check,
    // ephemeral cwd, lifetime kill, stderr cap, and (Linux production
    // only) ulimit -v wrap. URL transports ignore the payload.
    const snapshot = await getOrgConfigSnapshot(connection.orgId);
    const stdioSandbox = resolveStdioSandboxConfig(snapshot.mcp);
    const tools = await withMcpClient(
      () => buildDiscoveryClient(connection, stdioSandbox),
      (client) => client.listTools(),
    );
    const capped = tools.slice(0, MAX_DISCOVERY_TOOLS);
    for (const tool of capped) {
      await upsertToolDescriptor({
        connectionId: connection.id,
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }
    await setConnectionStatus({
      orgId: connection.orgId,
      connectionId: connection.id,
      status: "active",
      statusReason: null,
      lastDiscoveryAt: new Date(),
    });
    return { ok: true, tools: capped.length };
  } catch (err) {
    // SDK errors may embed URL fragments or path-encoded tokens. Run
    // through scrubSecretShapes on top of the 200-char truncation so an
    // accidental Bearer / sk- prefix in the error message can't land in
    // audit_logs.metadata or the connection's status_reason column.
    const raw = err instanceof Error ? err.message : "discovery failed";
    const reason = scrubSecretShapes(raw).slice(0, 200);
    await setConnectionStatus({
      orgId: connection.orgId,
      connectionId: connection.id,
      status: "failed",
      statusReason: reason,
      lastDiscoveryAt: new Date(),
    });
    return { ok: false, error: reason };
  }
}

function aliasFromUrl(url: string | undefined, prefix: string): string {
  const match = (url ?? "").match(new RegExp(`^${prefix}/([^/?]+)`));
  return match?.[1] ? decodeURIComponent(match[1]).trim().toLowerCase() : "";
}

function descriptorNameFromUrl(url: string | undefined): { alias: string; toolName: string } {
  const match = (url ?? "").match(/^\/mcp\/connections\/([^/]+)\/tools\/([^/?]+)/);
  return {
    alias: match?.[1] ? decodeURIComponent(match[1]).trim().toLowerCase() : "",
    toolName: match?.[2] ? decodeURIComponent(match[2]).trim() : "",
  };
}

export const mcpRoutes: Route[] = [
  // === List connections ===
  {
    method: "GET",
    match: "/mcp/connections",
    role: "viewer",
    permission: "mcp.connections.read",
    handler: async ({ res, auth }) => {
      const connections = await listConnections(auth.orgId);
      // Include the per-connection descriptor count so the panel can
      // show "12 tools / 3 enabled" without N+1 fetches.
      const enriched = await Promise.all(
        connections.map(async (connection) => {
          const tools = await listToolDescriptors(connection.id);
          return {
            ...connection,
            toolCount: tools.length,
            enabledToolCount: tools.filter((t) => t.enabled).length,
          };
        }),
      );
      return sendJson(res, { connections: enriched });
    },
  },

  // === Create connection + run initial discovery ===
  {
    method: "POST",
    match: "/mcp/connections",
    role: "admin",
    permission: "mcp.connections.write",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const alias = typeof body.alias === "string" ? body.alias.trim().toLowerCase() : "";
      if (!isValidAlias(alias)) {
        return sendJson(res, { error: "alias must match /^[a-z0-9_-]{1,32}$/" }, 400);
      }
      const transport = typeof body.transport === "string" ? body.transport : "";
      if (!TRANSPORTS.has(transport as McpTransport)) {
        return sendJson(res, { error: "transport must be stdio, sse, or http" }, 400);
      }

      const envRefs = parseEnvRefsBody(body.envRefs);
      let command: string | undefined;
      let args: string[] | undefined;
      let url: string | undefined;
      if (transport === "stdio") {
        command = typeof body.command === "string" ? body.command.trim() : "";
        if (!command) return sendJson(res, { error: "stdio transport requires a non-empty command" }, 400);
        args = parseArgsBody(body.args);
        const allowlist = await resolveCommandAllowlist(auth.orgId);
        if (allowlist.length === 0) {
          return sendJson(res, {
            error: "stdio command allowlist is empty (fail-closed). Set JANUSLY_MCP_ALLOWED_COMMANDS or org config mcp.clientCommandAllowlist before registering stdio connections.",
            code: "mcp_command_allowlist_empty",
          }, 400);
        }
        if (!allowlist.includes(command)) {
          return sendJson(res, {
            error: `command "${command}" is not in the allowlist. Allowed: ${allowlist.join(", ")}`,
            code: "mcp_command_not_allowed",
          }, 400);
        }
      } else {
        // `sse` and `http` both register a URL endpoint. The `transport`
        // literal distinguishes them at dispatch time inside the engine
        // (sse opens an `eventsource` stream; http uses
        // `StreamableHTTPClientTransport`'s POST + optional SSE). The
        // route-layer shape check is the same.
        url = typeof body.url === "string" ? body.url.trim() : "";
        if (!url) return sendJson(res, { error: `${transport} transport requires a non-empty url` }, 400);
      }

      const existing = await getConnectionByAlias({ orgId: auth.orgId, alias });
      if (existing) {
        return sendJson(res, errorEnvelope("mcp_connection_duplicate", "connection with this alias already exists", { alias }), 409);
      }

      const connection = await createConnection({
        orgId: auth.orgId,
        alias,
        transport: transport as McpTransport,
        command,
        args,
        url,
        envRefs,
        createdBy: auth.userId,
      });

      const discovery = await runDiscovery(connection);
      await audit(auth.orgId, auth.userId, "mcp.connection.created", "mcp_connection", connection.id, {
        alias,
        transport,
        discoveryOk: discovery.ok,
        discoveryError: discovery.ok ? undefined : discovery.error,
        toolCount: discovery.ok ? discovery.tools : 0,
      });

      const tools = await listToolDescriptors(connection.id);
      const fresh = await getConnectionByAlias({ orgId: auth.orgId, alias });
      return sendJson(res, { connection: fresh, tools, discovery });
    },
  },

  // === Update connection (POST /mcp/connections/:alias) ===
  {
    method: "POST",
    match: (url) => /^\/mcp\/connections\/[^/]+$/.test(url),
    role: "admin",
    permission: "mcp.connections.write",
    handler: async ({ req, res, auth }) => {
      const alias = aliasFromUrl(req.url, "/mcp/connections");
      if (!alias) return sendJson(res, { error: "alias is required" }, 400);

      const existing = await getConnectionByAlias({ orgId: auth.orgId, alias });
      if (!existing) return sendJson(res, errorEnvelope("mcp_connection_not_found", "connection not found", { alias }), 404);

      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const updates: Parameters<typeof updateConnection>[0] = { orgId: auth.orgId, alias };
      if (typeof body.enabled === "boolean") updates.enabled = body.enabled;
      if (body.envRefs !== undefined) updates.envRefs = parseEnvRefsBody(body.envRefs);
      if (body.args !== undefined && existing.transport === "stdio") updates.args = parseArgsBody(body.args);
      if (typeof body.url === "string" && (existing.transport === "sse" || existing.transport === "http")) {
        const url = body.url.trim();
        if (!url) return sendJson(res, { error: "url must be non-empty" }, 400);
        updates.url = url;
      }
      if (typeof body.command === "string" && existing.transport === "stdio") {
        const command = body.command.trim();
        if (!command) return sendJson(res, { error: "command must be non-empty" }, 400);
        const allowlist = await resolveCommandAllowlist(auth.orgId);
        if (allowlist.length === 0 || !allowlist.includes(command)) {
          return sendJson(res, {
            error: `command "${command}" is not in the allowlist.`,
            code: "mcp_command_not_allowed",
          }, 400);
        }
        updates.command = command;
      }
      // Admin opt-in flag for surfacing this connection's MCP tools to
      // `/ai/generate-workflow`'s system prompt. Defaults to false on
      // create; this PATCH is the only mutation surface.
      if (typeof body.exposeToAi === "boolean") updates.exposeToAi = body.exposeToAi;

      const { before, after } = await updateConnection(updates);
      // When the admin re-enables a disabled connection, return status to pending
      // so the discovery-status display reflects the operator intent.
      if (typeof body.enabled === "boolean") {
        if (!body.enabled) {
          await setConnectionStatus({ orgId: auth.orgId, connectionId: existing.id, status: "disabled", statusReason: "disabled by admin" });
        } else if (existing.status === "disabled") {
          await setConnectionStatus({ orgId: auth.orgId, connectionId: existing.id, status: "pending", statusReason: null });
        }
      }

      await audit(auth.orgId, auth.userId, "mcp.connection.updated", "mcp_connection", existing.id, {
        alias,
        enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
        envRefsChanged: body.envRefs !== undefined,
        commandChanged: body.command !== undefined,
        urlChanged: body.url !== undefined,
        argsChanged: body.args !== undefined,
        exposeToAiChanged: typeof body.exposeToAi === "boolean" && before
          ? body.exposeToAi !== before.exposeToAi
          : undefined,
      });

      // Audit-on-change for the exposeToAi flip — independent row so an
      // operator review can grep just the `mcp.connection.expose_to_ai_set`
      // history without scanning every generic `mcp.connection.updated`.
      if (typeof body.exposeToAi === "boolean" && before && body.exposeToAi !== before.exposeToAi) {
        await audit(
          auth.orgId,
          auth.userId,
          "mcp.connection.expose_to_ai_set",
          "mcp_connection",
          existing.id,
          { alias, before: before.exposeToAi, after: body.exposeToAi },
        );
      }

      const fresh = await getConnectionByAlias({ orgId: auth.orgId, alias });
      return sendJson(res, fresh ?? after);
    },
  },

  // === Delete connection ===
  {
    method: "DELETE",
    match: (url) => /^\/mcp\/connections\/[^/]+$/.test(url),
    role: "admin",
    permission: "mcp.connections.write",
    handler: async ({ req, res, auth }) => {
      const alias = aliasFromUrl(req.url, "/mcp/connections");
      if (!alias) return sendJson(res, { error: "alias is required" }, 400);

      const existing = await getConnectionByAlias({ orgId: auth.orgId, alias });
      if (!existing) return sendJson(res, errorEnvelope("mcp_connection_not_found", "connection not found", { alias }), 404);

      await deleteConnection({ orgId: auth.orgId, alias });
      await audit(auth.orgId, auth.userId, "mcp.connection.deleted", "mcp_connection", existing.id, {
        alias,
        transport: existing.transport,
      });
      return sendJson(res, { ok: true });
    },
  },

  // === Rediscover connection ===
  {
    method: "POST",
    match: (url) => /^\/mcp\/connections\/[^/]+\/rediscover$/.test(url),
    role: "admin",
    permission: "mcp.connections.write",
    handler: async ({ req, res, auth }) => {
      const match = (req.url ?? "").match(/^\/mcp\/connections\/([^/]+)\/rediscover$/);
      const alias = match?.[1] ? decodeURIComponent(match[1]).trim().toLowerCase() : "";
      if (!alias) return sendJson(res, { error: "alias is required" }, 400);

      // Cap rediscover spam — each rediscover drives a real outbound
      // connection (stdio spawn or SSE open). 10/min/org is plenty for
      // operators reacting to upstream version bumps, low enough to
      // keep a malicious admin from using it as a DoS amplifier.
      try {
        await enforceRateLimit(auth.orgId, { name: "mcp.rediscover", windowMs: 60_000, max: 10 });
      } catch (err) {
        const message = err instanceof Error ? err.message : "rate limit exceeded";
        return sendJson(res, { error: message }, 429);
      }

      const existing = await getConnectionByAlias({ orgId: auth.orgId, alias });
      if (!existing) return sendJson(res, errorEnvelope("mcp_connection_not_found", "connection not found", { alias }), 404);

      const before = await listToolDescriptors(existing.id);
      const discovery = await runDiscovery(existing);
      const after = await listToolDescriptors(existing.id);

      await audit(auth.orgId, auth.userId, "mcp.connection.rediscovered", "mcp_connection", existing.id, {
        alias,
        discoveryOk: discovery.ok,
        discoveryError: discovery.ok ? undefined : discovery.error,
        toolsBefore: before.length,
        toolsAfter: after.length,
      });
      const fresh = await getConnectionByAlias({ orgId: auth.orgId, alias });
      return sendJson(res, { connection: fresh, tools: after, discovery });
    },
  },

  // === List tool descriptors ===
  {
    method: "GET",
    match: (url) => /^\/mcp\/connections\/[^/]+\/tools$/.test(url),
    role: "viewer",
    permission: "mcp.connections.read",
    handler: async ({ req, res, auth }) => {
      const match = (req.url ?? "").match(/^\/mcp\/connections\/([^/]+)\/tools$/);
      const alias = match?.[1] ? decodeURIComponent(match[1]).trim().toLowerCase() : "";
      if (!alias) return sendJson(res, { error: "alias is required" }, 400);
      const connection = await getConnectionByAlias({ orgId: auth.orgId, alias });
      if (!connection) return sendJson(res, errorEnvelope("mcp_connection_not_found", "connection not found", { alias }), 404);
      const tools = await listToolDescriptors(connection.id);
      return sendJson(res, { tools });
    },
  },

  // === Toggle tool descriptor (enabled / writeSide / rateLimitPerMin) ===
  {
    method: "POST",
    match: (url) => /^\/mcp\/connections\/[^/]+\/tools\/[^/?]+$/.test(url),
    role: "admin",
    permission: "mcp.connections.write",
    handler: async ({ req, res, auth }) => {
      const { alias, toolName } = descriptorNameFromUrl(req.url);
      if (!alias || !toolName) return sendJson(res, { error: "alias and tool name are required" }, 400);

      const connection = await getConnectionByAlias({ orgId: auth.orgId, alias });
      if (!connection) return sendJson(res, errorEnvelope("mcp_connection_not_found", "connection not found", { alias }), 404);
      const descriptor = await getToolDescriptor({ connectionId: connection.id, name: toolName });
      if (!descriptor) return sendJson(res, errorEnvelope("mcp_tool_not_found", "tool not found", { tool: toolName }), 404);

      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const enabled = typeof body.enabled === "boolean" ? body.enabled : undefined;
      const writeSide = typeof body.writeSide === "boolean" ? body.writeSide : undefined;
      // Per-tool admin opt-in for LLM exposure. Mirrors `writeSide` /
      // `enabled` shape: explicit boolean or absent → no-op. The
      // descriptor only surfaces in `/ai/generate-workflow`'s prompt
      // when BOTH connection.exposeToAi AND descriptor.exposeToAi are
      // true; revoking either kills exposure for that one tool.
      const exposeToAi = typeof body.exposeToAi === "boolean" ? body.exposeToAi : undefined;

      // Per-tool rate-limit override. Three states distinguished:
      //   - field absent → leave the prior value alone (undefined).
      //   - explicit `null` → clear the override; tool reverts to the
      //     org default (`org_configs.mcp.clientRateLimitPerMin`).
      //   - positive integer in [1, 10_000] → set the override.
      // The upper bound is a sanity ceiling: the chokepoint must never
      // expose an effectively-unbounded rate-limit even when an admin
      // pastes a large number by mistake.
      let rateLimitPerMin: number | null | undefined;
      if ("rateLimitPerMin" in body) {
        const raw = body.rateLimitPerMin;
        if (raw === null) {
          rateLimitPerMin = null;
        } else if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 10_000) {
          rateLimitPerMin = raw;
        } else {
          return sendJson(res, { error: "rateLimitPerMin must be null or an integer in [1, 10000]" }, 400);
        }
      }

      if (
        enabled === undefined
        && writeSide === undefined
        && rateLimitPerMin === undefined
        && exposeToAi === undefined
      ) {
        return sendJson(res, { error: "no updatable fields provided" }, 400);
      }
      const { before, after } = await setToolFlags({
        connectionId: connection.id,
        name: toolName,
        enabled,
        writeSide,
        rateLimitPerMin,
        exposeToAi,
      });

      if (enabled !== undefined && before && enabled !== before.enabled) {
        await audit(
          auth.orgId,
          auth.userId,
          enabled ? "mcp.tool.enabled" : "mcp.tool.disabled",
          "mcp_tool",
          descriptor.id,
          { alias, toolName, writeSide: after?.writeSide },
        );
      }

      // Audit on actual change only — pinning to setting the same
      // value as before is a no-op for the audit trail.
      if (
        rateLimitPerMin !== undefined
        && before
        && rateLimitPerMin !== before.rateLimitPerMin
      ) {
        await audit(
          auth.orgId,
          auth.userId,
          "mcp.tool.rate_limit_set",
          "mcp_tool",
          descriptor.id,
          { alias, toolName, before: before.rateLimitPerMin, after: rateLimitPerMin },
        );
      }

      // Per-tool exposeToAi flip — also audited on actual change.
      // Independent row from the generic tool toggle so an operator
      // can grep just the `mcp.tool.expose_to_ai_set` history when
      // tracing what surfaces in the LLM prompt over time.
      if (
        exposeToAi !== undefined
        && before
        && exposeToAi !== before.exposeToAi
      ) {
        await audit(
          auth.orgId,
          auth.userId,
          "mcp.tool.expose_to_ai_set",
          "mcp_tool",
          descriptor.id,
          { alias, toolName, before: before.exposeToAi, after: exposeToAi },
        );
      }

      return sendJson(res, after);
    },
  },
];

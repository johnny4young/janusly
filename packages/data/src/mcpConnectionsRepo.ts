/**
 * MCP client connection + tool-descriptor catalog.
 *
 * Stores per-org external MCP server registrations (`mcp_connections`)
 * and the per-tool descriptors cached at discovery time
 * (`mcp_tool_descriptors`). Three transports are supported:
 *
 *  - `stdio`: spawn a local child process (`command` + `args`),
 *  - `sse`: open a remote SSE stream (`url`) — legacy MCP transport.
 *  - `http`: open a Streamable HTTP connection (`url`) — the
 *    canonical MCP transport per the June 2025 spec; supersedes
 *    `sse` for modern hosted servers.
 *
 * `envRefs` is a closed-shape JSONB: `Record<string, { kind: "env",
 * name: string }>`. Secret material never lives on the row — the
 * executor resolves each ref from `process.env[name]` at call time.
 *
 * Multi-tenant scope: every read / write filters by `orgId`. Unique on
 * `(orgId, alias)`. Tool descriptors join through the connection's
 * `orgId` — the executor refuses to invoke a tool whose connection's
 * `orgId` doesn't match the run.
 *
 * Used by:
 * - `apps/api/src/routes/mcp-routes.ts` — admin CRUD + discovery.
 * - `packages/engine/src/mcp-tool-executor.ts` — per-call lookup.
 */

import { and, eq } from "drizzle-orm";
import { db, mcpConnections, mcpToolDescriptors } from "@janusly/db";

export type McpTransport = "stdio" | "sse" | "http";

export type McpEnvRef = { kind: "env"; name: string };
export type McpEnvRefs = Record<string, McpEnvRef>;

export type McpConnectionStatus = "pending" | "active" | "failed" | "disabled";

export type McpConnectionRow = {
  id: string;
  orgId: string;
  alias: string;
  transport: McpTransport;
  command: string | null;
  args: string[] | null;
  url: string | null;
  envRefs: McpEnvRefs;
  enabled: boolean;
  status: McpConnectionStatus;
  statusReason: string | null;
  /**
   * Admin opt-in: when `true`, this connection's enabled tool
   * descriptors are surfaced to `/ai/generate-workflow`'s system
   * prompt (with descriptions sanitised via
   * `sanitizeMcpToolDescription`). Default `false` — third-party MCP
   * server descriptions are operator-supplied data and a potential
   * prompt-injection vector; admin must explicitly opt in. Audited
   * as `mcp.connection.expose_to_ai_set` on change.
   */
  exposeToAi: boolean;
  lastDiscoveryAt: Date | string | null;
  createdBy: string | null;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
};

export type McpToolDescriptorRow = {
  id: string;
  connectionId: string;
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown> | null;
  writeSide: boolean;
  enabled: boolean;
  /**
   * Per-tool rate-limit override in calls/min. `null` means "use the
   * org default" (`org_configs.mcp.clientRateLimitPerMin`, today 60).
   * A positive integer overrides for THIS descriptor only — every
   * other tool on the same connection still uses the org default.
   * Set / cleared by admins; audited as `mcp.tool.rate_limit_set`.
   */
  rateLimitPerMin: number | null;
  /**
   * Per-tool admin opt-in for LLM exposure. Default `false`. The
   * descriptor only surfaces in `/ai/generate-workflow`'s system
   * prompt when BOTH this flag AND the parent connection's
   * `exposeToAi` flag are `true` — revoking either kills exposure
   * for this tool immediately. Audited as `mcp.tool.expose_to_ai_set`
   * with before/after on each toggle.
   */
  exposeToAi: boolean;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
};

const TRANSPORTS = new Set<McpTransport>(["stdio", "sse", "http"]);

function isTransport(value: unknown): value is McpTransport {
  return typeof value === "string" && TRANSPORTS.has(value as McpTransport);
}

function isStatus(value: unknown): value is McpConnectionStatus {
  return value === "pending" || value === "active" || value === "failed" || value === "disabled";
}

function parseEnvRefs(value: unknown): McpEnvRefs {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: McpEnvRefs = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const ref = raw as Record<string, unknown>;
    if (ref.kind === "env" && typeof ref.name === "string" && ref.name.trim().length > 0) {
      out[key] = { kind: "env", name: ref.name.trim() };
    }
  }
  return out;
}

function parseArgs(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const v of value) {
    if (typeof v === "string") out.push(v);
  }
  return out.length > 0 ? out : null;
}

function mapConnectionRow(row: typeof mcpConnections.$inferSelect): McpConnectionRow {
  return {
    id: row.id,
    orgId: row.orgId,
    alias: row.alias,
    transport: isTransport(row.transport) ? row.transport : "stdio",
    command: row.command ?? null,
    args: parseArgs(row.args),
    url: row.url ?? null,
    envRefs: parseEnvRefs(row.envRefs),
    enabled: row.enabled,
    status: isStatus(row.status) ? row.status : "pending",
    statusReason: row.statusReason ?? null,
    exposeToAi: row.exposeToAi,
    lastDiscoveryAt: row.lastDiscoveryAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapDescriptorRow(row: typeof mcpToolDescriptors.$inferSelect): McpToolDescriptorRow {
  return {
    id: row.id,
    connectionId: row.connectionId,
    name: row.name,
    description: row.description,
    inputSchema:
      row.inputSchema && typeof row.inputSchema === "object" && !Array.isArray(row.inputSchema)
        ? (row.inputSchema as Record<string, unknown>)
        : null,
    writeSide: row.writeSide,
    enabled: row.enabled,
    rateLimitPerMin: typeof row.rateLimitPerMin === "number" ? row.rateLimitPerMin : null,
    exposeToAi: row.exposeToAi,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Read one connection scoped to an org. Returns `null` when no row exists. */
export async function getConnectionByAlias(input: { orgId: string; alias: string }): Promise<McpConnectionRow | null> {
  const rows = await db
    .select()
    .from(mcpConnections)
    .where(and(eq(mcpConnections.orgId, input.orgId), eq(mcpConnections.alias, input.alias)));
  const row = rows[0];
  return row ? mapConnectionRow(row) : null;
}

/** Read one connection by id, still scoped to org. Returns `null` when no row exists. */
export async function getConnectionById(input: { orgId: string; id: string }): Promise<McpConnectionRow | null> {
  const rows = await db
    .select()
    .from(mcpConnections)
    .where(and(eq(mcpConnections.orgId, input.orgId), eq(mcpConnections.id, input.id)));
  const row = rows[0];
  return row ? mapConnectionRow(row) : null;
}

/** List every connection registered for an org. */
export async function listConnections(orgId: string): Promise<McpConnectionRow[]> {
  const rows = await db.select().from(mcpConnections).where(eq(mcpConnections.orgId, orgId));
  return rows.map(mapConnectionRow);
}

/**
 * Insert a new connection row. Caller validates shape (alias regex,
 * transport-specific required fields). Returns the inserted row.
 */
export async function createConnection(input: {
  orgId: string;
  alias: string;
  transport: McpTransport;
  command?: string | null;
  args?: string[] | null;
  url?: string | null;
  envRefs: McpEnvRefs;
  createdBy?: string | null;
}): Promise<McpConnectionRow> {
  // Application-layer transport-shape check (no DB CHECK).
  if (input.transport === "stdio" && (!input.command || input.command.trim().length === 0)) {
    throw new Error("stdio transport requires a non-empty command");
  }
  if (input.transport === "sse" && (!input.url || input.url.trim().length === 0)) {
    throw new Error("sse transport requires a non-empty url");
  }
  if (input.transport === "http" && (!input.url || input.url.trim().length === 0)) {
    throw new Error("http transport requires a non-empty url");
  }

  // URL-shaped transports (`sse`, `http`) both store the endpoint in
  // the `url` column. The transport literal is the dispatcher key.
  const isUrlTransport = input.transport === "sse" || input.transport === "http";

  const id = crypto.randomUUID();
  await db.insert(mcpConnections).values({
    id,
    orgId: input.orgId,
    alias: input.alias,
    transport: input.transport,
    command: input.transport === "stdio" ? input.command! : null,
    args: input.transport === "stdio" ? input.args ?? [] : null,
    url: isUrlTransport ? input.url! : null,
    envRefs: input.envRefs,
    enabled: true,
    status: "pending",
    statusReason: null,
    createdBy: input.createdBy ?? null,
  });
  const created = await getConnectionByAlias({ orgId: input.orgId, alias: input.alias });
  if (!created) throw new Error("mcp_connections row vanished after insert");
  return created;
}

/**
 * Outcome of an `updateConnection` call. `before` holds the prior
 * values of the operator-controlled fields so the route handler can
 * emit an audit row only when something actually changed. `after` is
 * the refreshed row. Mirrors the `setToolFlags` pattern.
 */
export type UpdateConnectionResult = {
  before: { enabled: boolean; exposeToAi: boolean } | null;
  after: McpConnectionRow | null;
};

/**
 * Partial-update an existing connection (admin "edit" surface).
 *
 * `exposeToAi: undefined` leaves the prior value alone;
 * `exposeToAi: boolean` overrides. Same convention for `enabled` and
 * the transport-specific fields. Returns `{ before, after }` so the
 * caller can audit `enabled` flips and `exposeToAi` flips
 * independently — only audit when the value actually changed.
 */
export async function updateConnection(input: {
  orgId: string;
  alias: string;
  enabled?: boolean;
  envRefs?: McpEnvRefs;
  args?: string[];
  url?: string;
  command?: string;
  exposeToAi?: boolean;
}): Promise<UpdateConnectionResult> {
  const existing = await getConnectionByAlias({ orgId: input.orgId, alias: input.alias });
  const before = existing
    ? { enabled: existing.enabled, exposeToAi: existing.exposeToAi }
    : null;

  const updates: Partial<typeof mcpConnections.$inferInsert> = { updatedAt: new Date() };
  if (input.enabled !== undefined) updates.enabled = input.enabled;
  if (input.envRefs !== undefined) updates.envRefs = input.envRefs;
  if (input.args !== undefined) updates.args = input.args;
  if (input.url !== undefined) updates.url = input.url;
  if (input.command !== undefined) updates.command = input.command;
  if (input.exposeToAi !== undefined) updates.exposeToAi = input.exposeToAi;

  await db
    .update(mcpConnections)
    .set(updates)
    .where(and(eq(mcpConnections.orgId, input.orgId), eq(mcpConnections.alias, input.alias)));
  const after = await getConnectionByAlias({ orgId: input.orgId, alias: input.alias });
  return { before, after };
}

/** Update the discovery/health status of a connection. Used by the route's discovery flow. */
export async function setConnectionStatus(input: {
  orgId: string;
  connectionId: string;
  status: McpConnectionStatus;
  statusReason?: string | null;
  lastDiscoveryAt?: Date | null;
}): Promise<void> {
  await db
    .update(mcpConnections)
    .set({
      status: input.status,
      statusReason: input.statusReason ?? null,
      lastDiscoveryAt: input.lastDiscoveryAt ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(mcpConnections.orgId, input.orgId), eq(mcpConnections.id, input.connectionId)));
}

/**
 * Hard-delete a connection. Delete its descriptors first to
 * keep the parent-child invariant (no DB FK). The two deletes are
 * ordered descriptors-then-connection so a mid-call failure leaves a
 * connection with zero tools rather than an orphaned descriptor.
 */
export async function deleteConnection(input: { orgId: string; alias: string }): Promise<void> {
  const existing = await getConnectionByAlias(input);
  if (!existing) return;
  await db.delete(mcpToolDescriptors).where(eq(mcpToolDescriptors.connectionId, existing.id));
  await db
    .delete(mcpConnections)
    .where(and(eq(mcpConnections.orgId, input.orgId), eq(mcpConnections.alias, input.alias)));
}

/** Read one tool descriptor by `(connectionId, name)`. */
export async function getToolDescriptor(input: { connectionId: string; name: string }): Promise<McpToolDescriptorRow | null> {
  const rows = await db
    .select()
    .from(mcpToolDescriptors)
    .where(and(eq(mcpToolDescriptors.connectionId, input.connectionId), eq(mcpToolDescriptors.name, input.name)));
  const row = rows[0];
  return row ? mapDescriptorRow(row) : null;
}

/** List every descriptor cached for a connection. */
export async function listToolDescriptors(connectionId: string): Promise<McpToolDescriptorRow[]> {
  const rows = await db
    .select()
    .from(mcpToolDescriptors)
    .where(eq(mcpToolDescriptors.connectionId, connectionId));
  return rows.map(mapDescriptorRow);
}

/**
 * Insert or update a descriptor by `(connectionId, name)`. Preserves
 * the existing `enabled` flag (operator opt-in) and `writeSide` flag
 * when called from a re-discovery so an upstream rename doesn't lose
 * the admin's prior decisions.
 */
export async function upsertToolDescriptor(input: {
  connectionId: string;
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown> | null;
}): Promise<McpToolDescriptorRow> {
  const existing = await getToolDescriptor({ connectionId: input.connectionId, name: input.name });
  if (existing) {
    await db
      .update(mcpToolDescriptors)
      .set({
        description: input.description,
        inputSchema: input.inputSchema,
        updatedAt: new Date(),
      })
      .where(eq(mcpToolDescriptors.id, existing.id));
    const refreshed = await getToolDescriptor({ connectionId: input.connectionId, name: input.name });
    return refreshed ?? existing;
  }
  const id = crypto.randomUUID();
  await db.insert(mcpToolDescriptors).values({
    id,
    connectionId: input.connectionId,
    name: input.name,
    description: input.description,
    inputSchema: input.inputSchema,
    writeSide: true,
    enabled: false,
  });
  const created = await getToolDescriptor({ connectionId: input.connectionId, name: input.name });
  if (!created) throw new Error("mcp_tool_descriptors row vanished after insert");
  return created;
}

/**
 * Outcome of a `setToolFlags` call. `before` holds the prior values
 * of the operator-controlled fields so the route handler can emit an
 * audit row only when something actually changed (mirrors the
 * `mcp.tool.enabled/disabled` pattern). `after` is the refreshed row.
 */
export type SetToolFlagsResult = {
  before: {
    enabled: boolean;
    writeSide: boolean;
    rateLimitPerMin: number | null;
    exposeToAi: boolean;
  } | null;
  after: McpToolDescriptorRow | null;
};

/**
 * Set the operator-controlled flags on a tool descriptor. Every field
 * is optional — the admin can flip one without revisiting the others.
 *
 * `rateLimitPerMin: undefined` leaves the prior value alone;
 * `rateLimitPerMin: null` clears the per-tool override (revert to org
 * default); `rateLimitPerMin: <positive int>` sets the override.
 */
export async function setToolFlags(input: {
  connectionId: string;
  name: string;
  enabled?: boolean;
  writeSide?: boolean;
  rateLimitPerMin?: number | null;
  exposeToAi?: boolean;
}): Promise<SetToolFlagsResult> {
  const existing = await getToolDescriptor({ connectionId: input.connectionId, name: input.name });
  const before = existing
    ? {
        enabled: existing.enabled,
        writeSide: existing.writeSide,
        rateLimitPerMin: existing.rateLimitPerMin,
        exposeToAi: existing.exposeToAi,
      }
    : null;

  const updates: Partial<typeof mcpToolDescriptors.$inferInsert> = { updatedAt: new Date() };
  if (input.enabled !== undefined) updates.enabled = input.enabled;
  if (input.writeSide !== undefined) updates.writeSide = input.writeSide;
  // Distinguish "not provided" (undefined) from "explicit clear" (null).
  if (input.rateLimitPerMin !== undefined) updates.rateLimitPerMin = input.rateLimitPerMin;
  if (input.exposeToAi !== undefined) updates.exposeToAi = input.exposeToAi;

  await db
    .update(mcpToolDescriptors)
    .set(updates)
    .where(and(eq(mcpToolDescriptors.connectionId, input.connectionId), eq(mcpToolDescriptors.name, input.name)));

  const after = await getToolDescriptor({ connectionId: input.connectionId, name: input.name });
  return { before, after };
}

/**
 * Wipe every descriptor for a connection. Used at re-discovery time
 * when we want to drop tools that disappeared upstream — though the
 * default re-discovery flow uses upsert so existing opt-ins survive
 * server-side renames.
 */
export async function deleteToolDescriptorsForConnection(connectionId: string): Promise<void> {
  await db.delete(mcpToolDescriptors).where(eq(mcpToolDescriptors.connectionId, connectionId));
}

/**
 * One sanitised MCP tool entry ready to inject into the AI Studio's
 * system prompt. `description` has already been run through
 * `sanitizeMcpToolDescription` (Unicode hardening, control chars
 * stripped, known secret shapes scrubbed, length-capped at 300 chars).
 */
export type ExposedMcpTool = {
  connectionAlias: string;
  toolName: string;
  description: string;
};

/** Per-org token-budget caps for the LLM prompt injection. */
export const MAX_EXPOSED_TOOLS = 60;
export const MAX_EXPOSED_DESCRIPTION_BYTES = 20_000;

/**
 * List every MCP tool an org has opted in for AI exposure. Returns
 * sanitised descriptions in `(alias, name)`-stable order so the
 * downstream prompt composer can produce deterministic output (testable
 * + cacheable against the same dataset).
 *
 * Four independent filters apply (ALL must be true):
 *   - `connection.enabled === true` — disabled connections never expose tools.
 *   - `connection.exposeToAi === true` — admin opted in for this connection.
 *   - `descriptor.enabled === true` — operator opted in for tool execution.
 *   - `descriptor.exposeToAi === true` — admin opted in for THIS tool's
 *     description to reach the LLM. Per-tool granularity on top of the
 *     connection-level flag — revoking either kills exposure for that
 *     tool immediately.
 *
 * Capped at `MAX_EXPOSED_TOOLS` (60) and `MAX_EXPOSED_DESCRIPTION_BYTES`
 * (20 KB total UTF-8 bytes). When either cap is hit, a synthetic last
 * entry with `connectionAlias: "_truncated"`, `toolName: "_truncated"`,
 * and `description: "(N more truncated — narrow your opt-ins)"` is
 * appended so the LLM (and the operator) sees the truncation rather
 * than receiving a silently-clipped list.
 *
 * Multi-tenant scope: a single SQL JOIN scoped to `orgId` from the
 * `mcp_connections` side; tool descriptors inherit scope through the
 * `connectionId` foreign-key-style relationship.
 */
export async function listExposedMcpToolsForAi(orgId: string): Promise<ExposedMcpTool[]> {
  const rows = await db
    .select({
      alias: mcpConnections.alias,
      toolName: mcpToolDescriptors.name,
      description: mcpToolDescriptors.description,
    })
    .from(mcpConnections)
    .innerJoin(mcpToolDescriptors, eq(mcpToolDescriptors.connectionId, mcpConnections.id))
    .where(
      and(
        eq(mcpConnections.orgId, orgId),
        eq(mcpConnections.enabled, true),
        eq(mcpConnections.exposeToAi, true),
        eq(mcpToolDescriptors.enabled, true),
        eq(mcpToolDescriptors.exposeToAi, true),
      ),
    );

  // Lazy import to avoid pulling `@janusly/shared` into the data
  // package's runtime entry when this helper is not called. Shared is
  // browser-safe so this is purely a startup-cost optimisation; the
  // shared package compiles to TS modules consumed directly.
  const { sanitizeMcpToolDescription } = await import("@janusly/shared/src/error-signature");

  // Stable order: by alias, then tool name. Matches a future SQL
  // ORDER BY but kept in JS so the helper stays testable without a DB.
  rows.sort((a, b) => {
    if (a.alias !== b.alias) return a.alias < b.alias ? -1 : 1;
    return a.toolName < b.toolName ? -1 : a.toolName > b.toolName ? 1 : 0;
  });

  const out: ExposedMcpTool[] = [];
  let totalBytes = 0;
  let truncatedCount = 0;
  for (const row of rows) {
    if (out.length >= MAX_EXPOSED_TOOLS) {
      truncatedCount = rows.length - out.length;
      break;
    }
    const description = sanitizeMcpToolDescription(row.description);
    const projectedBytes = totalBytes + Buffer.byteLength(description, "utf8");
    if (projectedBytes > MAX_EXPOSED_DESCRIPTION_BYTES) {
      truncatedCount = rows.length - out.length;
      break;
    }
    out.push({
      connectionAlias: row.alias,
      toolName: row.toolName,
      description,
    });
    totalBytes = projectedBytes;
  }

  if (truncatedCount > 0) {
    out.push({
      connectionAlias: "_truncated",
      toolName: "_truncated",
      description: `(${truncatedCount} more truncated — narrow your opt-ins)`,
    });
  }

  return out;
}

// Multi-tenant invariant: tenant-scoped reads and writes keep orgId in the predicate; document system/global exceptions - see AGENTS.md "Decision engine / RL".

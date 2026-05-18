/**
 * MCP client connection + tool-descriptor catalog.
 *
 * Stores per-org external MCP server registrations (`mcp_connections`)
 * and the per-tool descriptors cached at discovery time
 * (`mcp_tool_descriptors`). Two transports are supported:
 *
 *  - `stdio`: spawn a local child process (`command` + `args`),
 *  - `sse`: open a remote SSE stream (`url`).
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

export type McpTransport = "stdio" | "sse";

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
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
};

const TRANSPORTS = new Set<McpTransport>(["stdio", "sse"]);

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

  const id = crypto.randomUUID();
  await db.insert(mcpConnections).values({
    id,
    orgId: input.orgId,
    alias: input.alias,
    transport: input.transport,
    command: input.transport === "stdio" ? input.command! : null,
    args: input.transport === "stdio" ? input.args ?? [] : null,
    url: input.transport === "sse" ? input.url! : null,
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

/** Partial-update an existing connection (admin "edit" surface). */
export async function updateConnection(input: {
  orgId: string;
  alias: string;
  enabled?: boolean;
  envRefs?: McpEnvRefs;
  args?: string[];
  url?: string;
  command?: string;
}): Promise<McpConnectionRow | null> {
  const updates: Partial<typeof mcpConnections.$inferInsert> = { updatedAt: new Date() };
  if (input.enabled !== undefined) updates.enabled = input.enabled;
  if (input.envRefs !== undefined) updates.envRefs = input.envRefs;
  if (input.args !== undefined) updates.args = input.args;
  if (input.url !== undefined) updates.url = input.url;
  if (input.command !== undefined) updates.command = input.command;

  await db
    .update(mcpConnections)
    .set(updates)
    .where(and(eq(mcpConnections.orgId, input.orgId), eq(mcpConnections.alias, input.alias)));
  return getConnectionByAlias({ orgId: input.orgId, alias: input.alias });
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
  before: { enabled: boolean; writeSide: boolean; rateLimitPerMin: number | null } | null;
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
}): Promise<SetToolFlagsResult> {
  const existing = await getToolDescriptor({ connectionId: input.connectionId, name: input.name });
  const before = existing
    ? { enabled: existing.enabled, writeSide: existing.writeSide, rateLimitPerMin: existing.rateLimitPerMin }
    : null;

  const updates: Partial<typeof mcpToolDescriptors.$inferInsert> = { updatedAt: new Date() };
  if (input.enabled !== undefined) updates.enabled = input.enabled;
  if (input.writeSide !== undefined) updates.writeSide = input.writeSide;
  // Distinguish "not provided" (undefined) from "explicit clear" (null).
  if (input.rateLimitPerMin !== undefined) updates.rateLimitPerMin = input.rateLimitPerMin;

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

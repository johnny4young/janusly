/**
 * Per-call execution flow for `mcp_tool` workflow nodes. The chokepoint
 * that takes a `{connectionAlias, toolName, input}` triple from a
 * workflow run and produces the `McpToolEnvelope` consumed by the
 * node executor.
 *
 * Responsibilities (in order):
 *  1. Resolve the connection by `(orgId, alias)`.
 *  2. Resolve the tool descriptor by `(connectionId, name)`.
 *  3. Refuse if the connection is disabled OR the tool is disabled
 *     OR the discovery status is not `active`.
 *  4. Validate input against the cached descriptor's JSON Schema subset.
 *  5. Honour the runtime dry-run gate (sandbox replays). Write-side
 *     MCP tools become a no-op stub in dry-run mode.
 *  6. Honour the two-flag write consent (process env + tenant config).
 *  7. Resolve env-refs from `process.env`. A missing env value
 *     surfaces a GENERIC `credential secret missing` envelope — never
 *     echo the env-var name.
 *  8. Per-call Redis-backed rate-limit (`mcp_client.<alias>.<tool>`).
 *     Fail-open on Redis blips, mirroring every other tool's posture.
 *  9. Build the transport-specific client, call the tool inside a
 *     `withMcpClient` so `close()` runs in a finally, return a
 *     normalised `{ ok, error?, output?, latencyMs, ... }` envelope.
 *
 * The function NEVER throws on runtime failures — every error becomes
 * `{ ok: false, error }`. The node executor consumes the envelope and
 * downstream `condition` nodes branch on `.ok`.
 *
 * Adding a new transport means a new branch in `buildClient` and a
 * new entry in `validateTransportShape`. Everything else (audit,
 * usage, dry-run, write-consent) is transport-agnostic.
 *
 * Used by:
 * - `packages/engine/src/node-registry.ts` — `mcp_tool` node executor.
 *
 * Invariants:
 * - Multi-tenant scope: the executor receives `orgId` from the run row
 *   and refuses to operate without it. The repo helpers all filter
 *   `eq(<table>.orgId, orgId)`.
 * - Env-var names never appear in error envelopes. The generic
 *   `credential secret missing` message mirrors the integration-tool
 *   contract.
 * - The audit + usage recorders fire on success AND failure.
 *   Telemetry must never break the call.
 */

import {
  getConnectionByAlias,
  getToolDescriptor,
  type McpConnectionRow,
  type McpToolDescriptorRow,
} from "@janusly/data/src/mcpConnectionsRepo";
import { scrubSecretShapes } from "@janusly/shared/src/error-signature";
import { createSseMcpClient, createStdioMcpClient, withMcpClient, type McpClient } from "./mcp-client";
import { getEngineRateLimiter } from "./rate-limit";
import { getMcpUsageRecorder } from "./mcp-usage";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

export type McpToolEnvelope = {
  ok: boolean;
  error?: string;
  /** Normalised output shape from the MCP SDK call. Present only on `ok: true`. */
  output?: Record<string, unknown>;
  /** Wall-clock latency from the executor's POV. Includes connect + call + close. */
  latencyMs: number;
  /** Echo back which connection / tool / transport produced the envelope (debug aid). */
  connectionAlias: string;
  toolName: string;
  transport: "stdio" | "sse";
  /** Echo the descriptor's `writeSide` flag for the audit row. */
  writeSide: boolean;
};

export type McpAuditCallback = (input: {
  ok: boolean;
  error?: string;
  latencyMs: number;
  writeSide: boolean;
}) => void | Promise<void>;

export type McpToolExecutorInput = {
  orgId: string;
  connectionAlias: string;
  toolName: string;
  input?: Record<string, unknown>;
  /** Per-call override; capped at `MAX_TIMEOUT_MS` (120s). Defaults to 30s. */
  timeoutMs?: number;
  /** Set by the node executor from `NodeContext.dryRun`. */
  dryRun?: boolean;
  /** Run-scope metadata for the audit + usage rows. */
  runId?: string;
  nodeId?: string;
  workflowId?: string;
  /**
   * Process-wide write-consent flag. The default reader returns
   * `process.env.JANUSLY_MCP_CLIENT_WRITES_ENABLED === "true"` but
   * tests inject this directly so they don't have to mutate env.
   */
  writeConsentProcess: boolean;
  /**
   * Tenant write-consent flag from `org_configs.mcp.clientWriteConsent`.
   * Read by the caller (node executor) so this module stays DB-agnostic.
   */
  writeConsentTenant: boolean;
  /**
   * Per-org rate-limit budget. Caller resolves this from
   * `org_configs.mcp.clientRateLimitPerMin` (or env fallback).
   */
  rateLimitPerMin: number;
  /**
   * Fires once per call (success or failure) so the route handler /
   * node executor can write run-level invocation metadata. The
   * executor itself stays free of `@janusly/db` imports.
   */
  onAudit?: McpAuditCallback;
};

/** Pure entrypoint. Never throws — returns a typed envelope on every path. */
export async function executeMcpTool(input: McpToolExecutorInput): Promise<McpToolEnvelope> {
  const start = Date.now();
  const audit = async (env: McpToolEnvelope) => {
    if (input.onAudit) {
      try {
        await input.onAudit({ ok: env.ok, error: env.error, latencyMs: env.latencyMs, writeSide: env.writeSide });
      } catch {
        // Audit writes must never break the tool path.
      }
    }
    await fireUsage({
      orgId: input.orgId,
      connectionAlias: env.connectionAlias,
      toolName: env.toolName,
      transport: env.transport,
      runId: input.runId,
      nodeId: input.nodeId,
      workflowId: input.workflowId,
      ok: env.ok,
      error: env.error,
      latencyMs: env.latencyMs,
      writeSide: env.writeSide,
    });
  };

  const envelopeBase = {
    connectionAlias: input.connectionAlias,
    toolName: input.toolName,
    transport: "stdio" as "stdio" | "sse",
    writeSide: true,
  };

  if (!input.orgId) {
    const env = { ...envelopeBase, ok: false, error: "mcp_tool requires multi-tenant context", latencyMs: 0 };
    await audit(env);
    return env;
  }

  let connection: McpConnectionRow | null;
  try {
    connection = await getConnectionByAlias({ orgId: input.orgId, alias: input.connectionAlias });
  } catch {
    const env = { ...envelopeBase, ok: false, error: "mcp_connection lookup failed", latencyMs: Date.now() - start };
    await audit(env);
    return env;
  }
  if (!connection) {
    const env = { ...envelopeBase, ok: false, error: `mcp connection not found: ${input.connectionAlias}`, latencyMs: Date.now() - start };
    await audit(env);
    return env;
  }
  envelopeBase.transport = connection.transport;

  if (!connection.enabled || connection.status === "disabled") {
    const env = { ...envelopeBase, ok: false, error: "mcp connection disabled", latencyMs: Date.now() - start };
    await audit(env);
    return env;
  }
  if (connection.status !== "active") {
    const env = { ...envelopeBase, ok: false, error: `mcp connection not active (status=${connection.status})`, latencyMs: Date.now() - start };
    await audit(env);
    return env;
  }

  let descriptor: McpToolDescriptorRow | null;
  try {
    descriptor = await getToolDescriptor({ connectionId: connection.id, name: input.toolName });
  } catch {
    const env = { ...envelopeBase, ok: false, error: "mcp tool lookup failed", latencyMs: Date.now() - start };
    await audit(env);
    return env;
  }
  if (!descriptor) {
    const env = { ...envelopeBase, ok: false, error: `mcp tool not found: ${input.toolName}`, latencyMs: Date.now() - start };
    await audit(env);
    return env;
  }
  envelopeBase.writeSide = descriptor.writeSide;
  if (!descriptor.enabled) {
    const env = { ...envelopeBase, ok: false, error: "mcp tool not enabled for this org", latencyMs: Date.now() - start };
    await audit(env);
    return env;
  }

  const inputValidationError = validateMcpToolInput(descriptor.inputSchema, input.input ?? {});
  if (inputValidationError) {
    const env = { ...envelopeBase, ok: false, error: inputValidationError, latencyMs: Date.now() - start };
    await audit(env);
    return env;
  }

  // Dry-run gate: write-side MCP tools are skipped during validation runs.
  // Read-side tools still execute so the validation produces real signal.
  if (input.dryRun && descriptor.writeSide) {
    const env: McpToolEnvelope = {
      ...envelopeBase,
      ok: true,
      output: { dryRun: true, skipped: true },
      latencyMs: Date.now() - start,
    };
    await audit(env);
    return env;
  }

  // Two-flag write consent (process + tenant). Identical pattern to the MCP
  // server side's `isMcpWriteAllowed`. Either flag false → reject.
  if (descriptor.writeSide) {
    if (!input.writeConsentProcess) {
      const env = { ...envelopeBase, ok: false, error: "mcp_client_writes_disabled (process)", latencyMs: Date.now() - start };
      await audit(env);
      return env;
    }
    if (!input.writeConsentTenant) {
      const env = { ...envelopeBase, ok: false, error: "mcp_client_writes_disabled (tenant)", latencyMs: Date.now() - start };
      await audit(env);
      return env;
    }
  }

  // Resolve env-refs from process.env. Missing values surface a generic
  // message — never echo the env-var name in errors. CR/LF values are
  // rejected pre-emptively so they can't smuggle a `\r\nX-Header: ...`
  // into the SSE transport's outbound request headers (the same
  // resolved values flow through as HTTP headers for SSE transport).
  const envForSpawn: Record<string, string> = {};
  for (const [key, ref] of Object.entries(connection.envRefs)) {
    if (ref.kind !== "env") continue;
    const value = process.env[ref.name];
    if (value === undefined || value === "") {
      const env = { ...envelopeBase, ok: false, error: `credential secret missing for ${key}`, latencyMs: Date.now() - start };
      await audit(env);
      return env;
    }
    if (/[\r\n]/.test(value)) {
      const env = { ...envelopeBase, ok: false, error: `credential value invalid for ${key}`, latencyMs: Date.now() - start };
      await audit(env);
      return env;
    }
    envForSpawn[key] = value;
  }

  // Per-tool rate-limit. Fail-open on Redis blips (matches the integration-tools posture).
  // Effective limit: a descriptor-level override (set by admins via the
  // tool-flags PATCH route) takes precedence over the org default the
  // caller resolved. NULL on the descriptor = use the caller's value.
  // The bucket key stays per-`(alias, toolName)` so lowering a specific
  // tool just throttles its own bucket faster without affecting the
  // sibling tools on the same connection.
  const effectiveRateLimit = typeof descriptor.rateLimitPerMin === "number"
    ? descriptor.rateLimitPerMin
    : input.rateLimitPerMin;
  const limiter = getEngineRateLimiter();
  if (limiter) {
    try {
      await limiter(`mcp_client.${connection.alias}.${input.toolName}`, input.orgId, {
        windowMs: 60_000,
        max: effectiveRateLimit,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : "rate limit exceeded";
      const env = { ...envelopeBase, ok: false, error, latencyMs: Date.now() - start };
      await audit(env);
      return env;
    }
  }

  const timeoutMs = clampTimeout(input.timeoutMs);

  // Build the transport-specific client and invoke.
  let envelope: McpToolEnvelope;
  try {
    envelope = await withMcpClient<McpToolEnvelope>(
      () => buildClientForConnection(connection!, envForSpawn),
      async (client) => {
        const result = await client.callTool({ name: input.toolName, input: input.input ?? {}, timeoutMs });
        const latencyMs = Date.now() - start;
        const isError = typeof result.output.isError === "boolean" ? result.output.isError : false;
        if (isError) {
          const errText = typeof result.output.text === "string" ? result.output.text : "mcp tool returned isError=true";
          return { ...envelopeBase, ok: false, error: scrubSecretShapes(errText).slice(0, 200), latencyMs };
        }
        return { ...envelopeBase, ok: true, output: result.output, latencyMs };
      },
    );
  } catch (err) {
    const latencyMs = Date.now() - start;
    const raw = err instanceof Error ? err.message : "mcp tool call failed";
    // The SDK occasionally surfaces upstream URLs in error messages
    // (mostly via fetchHttpTarget rejections). Truncate defensively
    // to avoid leaking a URL fragment that contains a path-encoded
    // secret — operators debug from latencyMs + the audit row, not
    // the error message text.
    envelope = { ...envelopeBase, ok: false, error: scrubSecretShapes(raw).slice(0, 200), latencyMs };
  }

  await audit(envelope);
  return envelope;
}

function clampTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1000) return DEFAULT_TIMEOUT_MS;
  if (value > MAX_TIMEOUT_MS) return MAX_TIMEOUT_MS;
  return Math.floor(value);
}

function validateMcpToolInput(schema: Record<string, unknown> | null, value: Record<string, unknown>): string | null {
  if (!schema) return null;
  if (schema.type !== undefined && !schemaAllowsType(schema.type, "object")) {
    return "mcp tool input schema must be an object schema";
  }

  const properties = readSchemaObject(schema.properties);
  const required = readStringArray(schema.required);
  for (const key of required) {
    if (!(key in value) || value[key] === undefined) {
      return `mcp tool input missing required field: ${key}`;
    }
  }

  for (const [key, propSchema] of Object.entries(properties)) {
    if (!(key in value) || value[key] === undefined) continue;
    const error = validateJsonSchemaValue(value[key], propSchema, key);
    if (error) return error;
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) return `mcp tool input contains unknown field: ${key}`;
    }
  }
  return null;
}

function validateJsonSchemaValue(value: unknown, schema: unknown, path: string): string | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  const obj = schema as Record<string, unknown>;
  const expectedType = obj.type;
  if (expectedType !== undefined && !valueMatchesSchemaType(value, expectedType)) {
    return `mcp tool input field ${path} must be ${formatSchemaType(expectedType)}`;
  }

  if (obj.enum !== undefined && Array.isArray(obj.enum) && !obj.enum.some((candidate) => deepJsonEqual(candidate, value))) {
    return `mcp tool input field ${path} must match an allowed value`;
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const nestedProperties = readSchemaObject(obj.properties);
    const nestedRequired = readStringArray(obj.required);
    const nestedValue = value as Record<string, unknown>;
    for (const key of nestedRequired) {
      if (!(key in nestedValue) || nestedValue[key] === undefined) {
        return `mcp tool input missing required field: ${path}.${key}`;
      }
    }
    for (const [key, propSchema] of Object.entries(nestedProperties)) {
      if (!(key in nestedValue) || nestedValue[key] === undefined) continue;
      const error = validateJsonSchemaValue(nestedValue[key], propSchema, `${path}.${key}`);
      if (error) return error;
    }
    if (obj.additionalProperties === false) {
      for (const key of Object.keys(nestedValue)) {
        if (!(key in nestedProperties)) return `mcp tool input contains unknown field: ${path}.${key}`;
      }
    }
  }

  if (Array.isArray(value) && obj.items !== undefined) {
    for (let i = 0; i < value.length; i += 1) {
      const error = validateJsonSchemaValue(value[i], obj.items, `${path}[${i}]`);
      if (error) return error;
    }
  }

  return null;
}

function valueMatchesSchemaType(value: unknown, schemaType: unknown): boolean {
  if (Array.isArray(schemaType)) return schemaType.some((type) => valueMatchesSchemaType(value, type));
  if (typeof schemaType !== "string") return true;
  if (schemaType === "null") return value === null;
  if (value === null) return false;
  if (schemaType === "integer") return typeof value === "number" && Number.isInteger(value);
  if (schemaType === "number") return typeof value === "number" && Number.isFinite(value);
  if (schemaType === "array") return Array.isArray(value);
  if (schemaType === "object") return typeof value === "object" && !Array.isArray(value);
  if (schemaType === "boolean") return typeof value === "boolean";
  if (schemaType === "string") return typeof value === "string";
  return true;
}

function schemaAllowsType(schemaType: unknown, expected: string): boolean {
  if (Array.isArray(schemaType)) return schemaType.includes(expected);
  return schemaType === expected;
}

function formatSchemaType(schemaType: unknown): string {
  if (Array.isArray(schemaType)) return schemaType.filter((type): type is string => typeof type === "string").join(" or ");
  return typeof schemaType === "string" ? schemaType : "the expected type";
}

function readSchemaObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function deepJsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function buildClientForConnection(connection: McpConnectionRow, env: Record<string, string>): Promise<McpClient> {
  if (connection.transport === "stdio") {
    if (!connection.command) throw new Error("stdio connection missing command");
    return createStdioMcpClient({
      command: connection.command,
      args: connection.args ?? [],
      env,
    });
  }
  if (connection.transport === "sse") {
    if (!connection.url) throw new Error("sse connection missing url");
    // The env map becomes HTTP headers for SSE transport — the same
    // resolved secret values flow to the remote server as headers
    // (e.g. `Authorization: Bearer <token>`) rather than as process env.
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) headers[key] = value;
    return createSseMcpClient({ url: connection.url, headers });
  }
  throw new Error(`unknown mcp transport: ${connection.transport}`);
}

async function fireUsage(input: {
  orgId: string;
  connectionAlias: string;
  toolName: string;
  transport: "stdio" | "sse";
  runId?: string;
  nodeId?: string;
  workflowId?: string;
  ok: boolean;
  error?: string;
  latencyMs: number;
  writeSide: boolean;
}): Promise<void> {
  const recorder = getMcpUsageRecorder();
  if (!recorder) return;
  try {
    await recorder({
      orgId: input.orgId,
      connectionAlias: input.connectionAlias,
      toolName: input.toolName,
      transport: input.transport,
      runId: input.runId,
      nodeId: input.nodeId,
      workflowId: input.workflowId,
      ok: input.ok,
      error: input.error,
      latencyMs: input.latencyMs,
      writeSide: input.writeSide,
    });
  } catch {
    // Telemetry must never break the tool path.
  }
}

/** Process-env reader for the boolean write-consent flag. Tests pass the resolved value instead. */
export function readMcpClientWritesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.JANUSLY_MCP_CLIENT_WRITES_ENABLED === "true";
}

/** Resolve the per-org rate-limit budget with env fallback. */
export function resolveMcpClientRateLimitPerMin(tenantOverride: number | null, env: NodeJS.ProcessEnv = process.env): number {
  if (typeof tenantOverride === "number" && tenantOverride > 0) return tenantOverride;
  const raw = env.JANUSLY_MCP_CLIENT_RATE_LIMIT_PER_MIN;
  const n = raw ? Number(raw) : NaN;
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return 60;
}

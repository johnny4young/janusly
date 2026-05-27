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
 * `{ ok: false, error }`. The `mcp_tool` node executor then converts
 * `ok: false` into a throw so the existing retry / DLQ machinery handles
 * failed external calls consistently with `http` nodes.
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
import { RATE_LIMIT_WINDOW_MS } from "./constants";
import { createHttpMcpClient, createSseMcpClient, createStdioMcpClient, withMcpClient, type McpClient } from "./mcp-client";
import {
  McpSandboxCommandNotAllowedError,
  McpSandboxLifetimeExceededError,
  McpSandboxStderrExceededError,
} from "./mcp-sandbox";
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
  transport: "stdio" | "sse" | "http";
  /** Echo the descriptor's `writeSide` flag for the audit row. */
  writeSide: boolean;
};

export type McpAuditCallback = (input: {
  ok: boolean;
  error?: string;
  latencyMs: number;
  writeSide: boolean;
  /**
   * Sandbox-driven termination reason. Set only for stdio failures
   * caused by allowlist rejection, lifetime kill, or stderr cap; null
   * for SDK errors, isError responses, dry-run skips, and successes.
   * Distinct from `error` so the audit row can branch deterministically.
   */
  sandboxFailureCode?: string | null;
  /**
   * Last 1024 chars of the redacted stderr tail captured from the stdio
   * child. Already scrubbed by `scrubSecretShapes`. Null for sse / http
   * transports + for any path where no stderr accumulated.
   */
  capturedStderrTail?: string | null;
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
   * Stdio sandbox config. Required for stdio transports; ignored for
   * sse / http (URL transports don't spawn a child). Caller resolves
   * `allowedCommands` as the union of env CSV + tenant CSV, and the
   * caps from `org_configs.mcp.stdio*` (with env fallbacks).
   */
  stdioSandbox: {
    allowedCommands: string[];
    maxLifetimeMs?: number;
    maxStderrBytes?: number;
    maxVmKb?: number;
    enforceLinuxUlimit: boolean;
  };
  /**
   * Fires once per call (success or failure) so the route handler /
   * node executor can write run-level invocation metadata. The
   * executor itself stays free of `@janusly/db` imports. On
   * sandbox-driven termination, the executor passes the redacted
   * stderr tail + the typed reason so the audit row carries diagnostic
   * context without leaking raw secret-shaped bytes.
   */
  onAudit?: McpAuditCallback;
};

/**
 * Reason codes emitted in the `{ ok: false, error }` envelope when the
 * stdio sandbox layer fires. Distinct from the existing free-form
 * error strings so audit + UI surfaces can branch deterministically.
 */
export const SANDBOX_ERROR_CODES = {
  COMMAND_REJECTED: "mcp_sandbox_command_rejected",
  LIFETIME_EXCEEDED: "mcp_sandbox_lifetime_exceeded",
  STDERR_EXCEEDED: "mcp_sandbox_stderr_exceeded",
} as const;

/** Pure entrypoint. Never throws — returns a typed envelope on every path. */
export async function executeMcpTool(input: McpToolExecutorInput): Promise<McpToolEnvelope> {
  const start = Date.now();
  const audit = async (
    env: McpToolEnvelope,
    extras: { sandboxFailureCode?: string | null; capturedStderrTail?: string | null } = {},
  ) => {
    if (input.onAudit) {
      try {
        await input.onAudit({
          ok: env.ok,
          error: env.error,
          latencyMs: env.latencyMs,
          writeSide: env.writeSide,
          sandboxFailureCode: extras.sandboxFailureCode ?? null,
          capturedStderrTail: extras.capturedStderrTail ?? null,
        });
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
    transport: "stdio" as "stdio" | "sse" | "http",
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
  // into the URL-shaped transports' outbound request headers (the same
  // resolved values flow through as HTTP headers for sse + http).
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
        windowMs: RATE_LIMIT_WINDOW_MS,
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

  // Build the transport-specific client and invoke. The sandbox layer
  // exposes a snapshot helper (`getSandboxSnapshot`) the callback below
  // reads BEFORE returning — the snapshot's redacted stderr tail flows
  // through to the audit row on every path that involves a stdio child.
  let envelope: McpToolEnvelope;
  let sandboxFailureCode: typeof SANDBOX_ERROR_CODES[keyof typeof SANDBOX_ERROR_CODES] | null = null;
  let capturedStderrTail: string | null = null;

  try {
    envelope = await withMcpClient<McpToolEnvelope>(
      () => buildClientForConnection(connection!, envForSpawn, input.stdioSandbox),
      async (client) => {
        try {
          const result = await client.callTool({ name: input.toolName, input: input.input ?? {}, timeoutMs });
          const latencyMs = Date.now() - start;
          const isError = typeof result.output.isError === "boolean" ? result.output.isError : false;
          // Snapshot BEFORE close (which runs in withMcpClient's finally).
          // The buffer is preserved in the capture closure post-dispose,
          // so reading it after close would also work, but doing it here
          // keeps the data flow explicit.
          const snap = client.getSandboxSnapshot?.();
          if (snap) capturedStderrTail = snap.capturedStderr.slice(-1024);
          if (isError) {
            const errText = typeof result.output.text === "string" ? result.output.text : "mcp tool returned isError=true";
            return { ...envelopeBase, ok: false, error: scrubSecretShapes(errText).slice(0, 200), latencyMs };
          }
          return { ...envelopeBase, ok: true, output: result.output, latencyMs };
        } catch (innerErr) {
          // Read the snapshot before re-throwing so the outer catch sees
          // the captured tail. withMcpClient's finally will still close
          // the client; the capture's getSnapshot stays callable.
          const snap = client.getSandboxSnapshot?.();
          if (snap) capturedStderrTail = snap.capturedStderr.slice(-1024);
          throw innerErr;
        }
      },
    );
  } catch (err) {
    const latencyMs = Date.now() - start;

    // Map typed sandbox errors to stable envelope codes. Free-form SDK
    // errors keep the existing scrubbed-truncated treatment.
    if (err instanceof McpSandboxCommandNotAllowedError) {
      sandboxFailureCode = SANDBOX_ERROR_CODES.COMMAND_REJECTED;
      envelope = {
        ...envelopeBase,
        ok: false,
        error: `${SANDBOX_ERROR_CODES.COMMAND_REJECTED}: ${err.reason}`,
        latencyMs,
      };
    } else if (err instanceof McpSandboxLifetimeExceededError) {
      sandboxFailureCode = SANDBOX_ERROR_CODES.LIFETIME_EXCEEDED;
      envelope = {
        ...envelopeBase,
        ok: false,
        error: SANDBOX_ERROR_CODES.LIFETIME_EXCEEDED,
        latencyMs,
      };
    } else if (err instanceof McpSandboxStderrExceededError) {
      sandboxFailureCode = SANDBOX_ERROR_CODES.STDERR_EXCEEDED;
      envelope = {
        ...envelopeBase,
        ok: false,
        error: SANDBOX_ERROR_CODES.STDERR_EXCEEDED,
        latencyMs,
      };
    } else {
      const raw = err instanceof Error ? err.message : "mcp tool call failed";
      // The SDK occasionally surfaces upstream URLs in error messages
      // (mostly via fetchHttpTarget rejections). Truncate defensively
      // to avoid leaking a URL fragment that contains a path-encoded
      // secret — operators debug from latencyMs + the audit row, not
      // the error message text.
      envelope = { ...envelopeBase, ok: false, error: scrubSecretShapes(raw).slice(0, 200), latencyMs };
    }
  }

  // The audit recorder + usage recorder both fire from the same shared
  // helper. Sandbox-driven failures attach the redacted stderr tail
  // and the typed reason code so compliance reads can distinguish
  // operator-driven errors from sandbox kills.
  await audit(envelope, { sandboxFailureCode, capturedStderrTail });
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

async function buildClientForConnection(
  connection: McpConnectionRow,
  env: Record<string, string>,
  stdioSandbox: McpToolExecutorInput["stdioSandbox"],
): Promise<McpClient> {
  if (connection.transport === "stdio") {
    if (!connection.command) throw new Error("stdio connection missing command");
    return createStdioMcpClient({
      command: connection.command,
      args: connection.args ?? [],
      env,
      sandbox: stdioSandbox,
    });
  }
  if (connection.transport === "sse" || connection.transport === "http") {
    if (!connection.url) throw new Error(`${connection.transport} connection missing url`);
    // The env map becomes HTTP headers for both URL-shaped transports —
    // the same resolved secret values flow to the remote server as
    // headers (e.g. `Authorization: Bearer <token>`) rather than as
    // process env. Same posture for sse + http; the only difference is
    // the SDK transport class.
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) headers[key] = value;
    return connection.transport === "sse"
      ? createSseMcpClient({ url: connection.url, headers })
      : createHttpMcpClient({ url: connection.url, headers });
  }
  throw new Error(`unknown mcp transport: ${connection.transport}`);
}

async function fireUsage(input: {
  orgId: string;
  connectionAlias: string;
  toolName: string;
  transport: "stdio" | "sse" | "http";
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

/**
 * Parse a comma-separated allowlist string into a trimmed string array.
 * Empty entries are dropped. The union with the env-side value is the
 * caller's responsibility — same shape as the registration-time
 * `resolveCommandAllowlist` in `apps/api/src/routes/mcp-routes.ts`.
 */
export function parseCommandAllowlist(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
}

/**
 * Resolve the stdio sandbox config for a single call. The caller passes
 * the org's `org_configs.mcp` snapshot and the resolver applies env
 * fallbacks for the allowlist + the enforce flag.
 *
 * Tenant override wins when the tenant allowlist is non-empty; falls
 * back to the env CSV otherwise. Mirrors the registration-time
 * `resolveCommandAllowlist` in `apps/api/src/routes/mcp-routes.ts`, so
 * the spawn-time re-check sees the SAME allowlist the registration
 * gate saw. The defense-in-depth is in the timing, not in a different
 * source of truth.
 *
 * `enforceLinuxUlimit` defaults to true only on Linux production. The
 * `JANUSLY_MCP_SANDBOX_ENFORCE_LINUX` env can force-enable on dev/test
 * Linux (e.g. CI) or force-disable on production (e.g. a distroless
 * image that lacks `/bin/sh`).
 */
export function resolveStdioSandboxConfig(
  mcpConfig: {
    clientCommandAllowlist: string;
    stdioMaxLifetimeMs: number;
    stdioMaxStderrBytes: number;
    stdioMaxVmKb: number;
  },
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): McpToolExecutorInput["stdioSandbox"] {
  const tenantList = parseCommandAllowlist(mcpConfig.clientCommandAllowlist);
  const envList = parseCommandAllowlist(env.JANUSLY_MCP_ALLOWED_COMMANDS);
  // Tenant override wins when non-empty; otherwise fall through to env.
  // Same precedence as the registration-time resolver so the spawn-time
  // re-check evaluates an equivalent list.
  const allowedCommands = tenantList.length > 0 ? tenantList : envList;

  const enforceEnv = env.JANUSLY_MCP_SANDBOX_ENFORCE_LINUX;
  let enforceLinuxUlimit: boolean;
  if (enforceEnv === "true") enforceLinuxUlimit = true;
  else if (enforceEnv === "false") enforceLinuxUlimit = false;
  else enforceLinuxUlimit = platform === "linux" && env.NODE_ENV === "production";

  return {
    allowedCommands,
    maxLifetimeMs: mcpConfig.stdioMaxLifetimeMs,
    maxStderrBytes: mcpConfig.stdioMaxStderrBytes,
    maxVmKb: mcpConfig.stdioMaxVmKb,
    enforceLinuxUlimit,
  };
}

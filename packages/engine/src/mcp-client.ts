/**
 * Transport-agnostic MCP client wrapper around `@modelcontextprotocol/sdk`.
 *
 * Exposes two operations the executor cares about:
 *  - `listTools()` — used by discovery to cache descriptors.
 *  - `callTool({name, input, timeoutMs})` — used per workflow step.
 *
 * Three factory functions, one per supported transport:
 *  - `createStdioMcpClient({command, args, env})` spawns a local child
 *    process and speaks JSON-RPC over its stdin/stdout. The spawn env
 *    is a strict whitelist (`{ PATH, ...envRefs }`) so a misconfigured
 *    third-party MCP server cannot read `DATABASE_URL` or any other
 *    `process.env` value the worker carries.
 *  - `createSseMcpClient({url, headers})` opens a legacy SSE
 *    connection to a remote MCP server. The URL is validated up-front,
 *    then every SDK fetch is routed through Janusly's response-preserving
 *    pinned fetch adapter so validation and TCP connect use the same IP.
 *  - `createHttpMcpClient({url, headers})` opens a Streamable HTTP
 *    connection (the canonical MCP transport per the June 2025 spec;
 *    supersedes SSE). Same SSRF and DNS-rebinding posture as `sse`, same
 *    headers pass-through. The SDK's `StreamableHTTPClientTransport`
 *    owns the POST + optional SSE wire format.
 *
 * The factory itself does NOT call `connect()` — the caller does that
 * inside a try/finally so `close()` always runs even if the connect
 * throws. `withMcpClient` is the convenience helper that does exactly
 * this.
 *
 * Used by:
 * - `packages/engine/src/mcp-tool-executor.ts` — per-call invocation.
 * - `apps/api/src/routes/mcp-routes.ts` — discovery + re-discovery.
 *
 * Invariants:
 * - The `callTool` result is normalised to `{ output, latencyMs }`. The
 *   SDK's content-array shape is collapsed into a single `output`
 *   object so workflow nodes can read it uniformly; the raw SDK
 *   response stays accessible via `output.raw`.
 * - `timeoutMs` is a hard cap. The wrapper races the promise against a
 *   `setTimeout` and rejects with `Error("timeout")` — closing the
 *   client is the caller's responsibility (`close()` aborts the
 *   transport).
 * - The stdio spawn env is rebuilt from scratch on every connect.
 *   Re-using a process env reference would defeat the secret-leak
 *   guard.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createPinnedHttpFetch, validateHttpTarget } from "./http-policy";
import {
  buildSandboxProfile,
  captureRedactedStderr,
  McpSandboxLifetimeExceededError,
  McpSandboxStderrExceededError,
  SANDBOX_KILL_GRACE_MS,
  type SandboxProfile,
  type StderrCaptureHandle,
} from "./mcp-sandbox";

export type McpClientToolDescriptor = {
  name: string;
  description: string | null;
  inputSchema: Record<string, unknown> | null;
};

export type McpClientCallResult = {
  /** Normalised tool output. Carries `raw` for the verbatim SDK response. */
  output: Record<string, unknown>;
  /** Wall-clock latency in milliseconds from before send to after receive. */
  latencyMs: number;
};

export interface McpClient {
  listTools(): Promise<McpClientToolDescriptor[]>;
  callTool(input: { name: string; input?: Record<string, unknown>; timeoutMs: number }): Promise<McpClientCallResult>;
  close(): Promise<void>;
  /**
   * Stdio sandbox snapshot. Returns null for URL transports (sse / http)
   * because they don't spawn a child process. For stdio: returns the
   * captured + redacted stderr buffer plus the truncation / lifetime
   * flags so the executor can attach the tail to error envelopes and
   * audit rows.
   */
  getSandboxSnapshot?(): SandboxClientSnapshot | null;
}

/**
 * Stdio-specific introspection on the sandbox layer. The executor reads
 * this on every failure path so the error envelope can carry the
 * captured stderr tail + a typed reason (lifetime / stderr cap / SDK).
 */
export type SandboxClientSnapshot = {
  capturedStderr: string;
  stderrTruncated: boolean;
  stderrByteCount: number;
  /** True when the lifetime watchdog terminated the child. */
  lifetimeExceeded: boolean;
  /** True when the stderr cap fired (and the child was killed). */
  stderrExceeded: boolean;
  /** Whether the Linux ulimit -v wrap was applied (mirrors profile.enforced). */
  enforced: boolean;
};

/**
 * Stdio MCP factory input. The `sandbox` block is REQUIRED — callers
 * (executor + discovery) must explicitly resolve the allowlist + caps
 * before reaching this layer. The signature change is intentional:
 * dropping `sandbox` makes the call a TypeScript error, which is the
 * point.
 */
export type StdioClientInput = {
  command: string;
  args?: string[];
  env: Record<string, string>;
  sandbox: {
    allowedCommands: string[];
    maxLifetimeMs?: number;
    maxStderrBytes?: number;
    maxVmKb?: number;
    enforceLinuxUlimit: boolean;
  };
};

/**
 * Stdio MCP client. The spawn env is a fresh object containing only
 * `PATH` (so the child can locate its own deps) plus the explicit
 * `envRefs` the admin declared on the connection. Never spread
 * `process.env` here.
 *
 * The sandbox layer applies five defenses (see `mcp-sandbox.ts`):
 * allowlist re-check at spawn time, ephemeral cwd, lifetime kill,
 * stderr byte cap with secret-shape redaction, and (on production
 * Linux only) `ulimit -v` virtual-memory wrap via `/bin/sh -c`.
 * Sandbox failures surface as typed errors on the next `listTools` /
 * `callTool` call, with the captured (redacted) stderr available via
 * `getSandboxSnapshot()`.
 */
export function createStdioMcpClient(input: StdioClientInput): McpClient {
  // a-e. Sandbox profile resolution. Allowlist rejection throws BEFORE
  // we open any cwd or transport — caller catches the typed error.
  const profile: SandboxProfile = buildSandboxProfile({
    command: input.command,
    args: input.args ?? [],
    platform: process.platform,
    allowedCommands: input.sandbox.allowedCommands,
    maxLifetimeMs: input.sandbox.maxLifetimeMs,
    maxStderrBytes: input.sandbox.maxStderrBytes,
    maxVmKb: input.sandbox.maxVmKb,
    enforceLinuxUlimit: input.sandbox.enforceLinuxUlimit,
    tempDir: tmpdir(),
    mkdtempSync,
  });

  // Whitelist the absolute minimum env. `PATH` is required so the
  // child can find node / uvx / npx binaries; everything else comes
  // from the admin's declared envRefs.
  const spawnEnv: Record<string, string> = { PATH: process.env.PATH ?? "" };
  for (const [key, value] of Object.entries(input.env)) {
    if (typeof value === "string") spawnEnv[key] = value;
  }

  // Constructor may throw synchronously (bad command path, EACCES on
  // the ephemeral cwd, malformed args). The caller never receives a
  // client to `close()`, so the cwd would orphan in /tmp. Roll back the
  // mkdtemp allocation here so the factory's failure modes leave no
  // disk residue.
  let transport: StdioClientTransport;
  try {
    transport = new StdioClientTransport({
      command: profile.wrappedCommand,
      args: profile.wrappedArgs,
      env: spawnEnv,
      cwd: profile.cwd,
      // Pipe so the sandbox can read + redact + cap. The SDK doesn't
      // consume stderr itself; we own this stream.
      stderr: "pipe",
    });
  } catch (err) {
    try {
      rmSync(profile.cwd, { recursive: true, force: true });
    } catch {
      // Best-effort rollback; the original throw is what the caller
      // needs to see.
    }
    throw err;
  }

  let stderrExceeded = false;
  let lifetimeExceeded = false;
  let lifetimeTimer: ReturnType<typeof setTimeout> | null = null;
  let killEscalationTimer: ReturnType<typeof setTimeout> | null = null;

  // Lazy stderr capture — attach on first connect so we don't miss
  // early chunks but also don't fight the SDK's own setup. The
  // StdioClientTransport exposes `stderr` once the child has spawned.
  let stderrCapture: StderrCaptureHandle | null = null;

  function attachStderrCapture() {
    if (stderrCapture) return;
    const stream = (transport as { stderr?: NodeJS.ReadableStream | null }).stderr ?? null;
    stderrCapture = captureRedactedStderr(stream, {
      maxBytes: profile.maxStderrBytes,
      onTruncate: () => {
        stderrExceeded = true;
        // Kill the child — the sandbox layer's stderr cap is also a
        // child-misbehaviour signal. Better to lose the in-flight call
        // than let the runaway child keep emitting.
        void killTransport("SIGTERM");
      },
    });
  }

  function armLifetimeTimer() {
    if (lifetimeTimer) return;
    lifetimeTimer = setTimeout(() => {
      lifetimeExceeded = true;
      void killTransport("SIGTERM");
    }, profile.maxLifetimeMs);
  }

  async function killTransport(initialSignal: "SIGTERM" | "SIGKILL"): Promise<void> {
    try {
      await transport.close();
    } catch {
      // Already closed or never connected. Continue to escalation —
      // if the child is still alive on its own pid, SIGKILL still
      // applies.
    }
    // SIGKILL escalation after a grace period. The transport's
    // `pid` getter is exposed by the SDK when the child is alive.
    if (initialSignal === "SIGTERM" && !killEscalationTimer) {
      killEscalationTimer = setTimeout(() => {
        const pid = (transport as { pid?: number }).pid;
        if (typeof pid === "number" && pid > 0) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Child already exited. Ignore.
          }
        }
      }, SANDBOX_KILL_GRACE_MS);
    }
  }

  function cleanup() {
    if (lifetimeTimer) {
      clearTimeout(lifetimeTimer);
      lifetimeTimer = null;
    }
    if (killEscalationTimer) {
      clearTimeout(killEscalationTimer);
      killEscalationTimer = null;
    }
    stderrCapture?.dispose();
    // Best-effort cwd cleanup. A leaked dir lives in `/tmp` until the
    // OS rolls it — acceptable because nothing secret lives there
    // (env values are passed via the spawn `env`, not written to disk).
    try {
      rmSync(profile.cwd, { recursive: true, force: true });
    } catch {
      // Ignore: best-effort cleanup.
    }
  }

  function snapshot(): SandboxClientSnapshot {
    const cap = stderrCapture?.getSnapshot() ?? { capturedRedacted: "", truncated: false, byteCount: 0 };
    return {
      capturedStderr: cap.capturedRedacted,
      stderrTruncated: cap.truncated,
      stderrByteCount: cap.byteCount,
      lifetimeExceeded,
      stderrExceeded,
      enforced: profile.enforced,
    };
  }

  return buildClient(transport, {
    onConnect: () => {
      attachStderrCapture();
      armLifetimeTimer();
    },
    onClose: cleanup,
    snapshot,
    // Surface sandbox-driven termination as a typed error so the
    // executor can map it to a clean envelope code.
    sandboxStateGetter: () => ({
      lifetimeExceeded,
      stderrExceeded,
      maxLifetimeMs: profile.maxLifetimeMs,
      maxStderrBytes: profile.maxStderrBytes,
    }),
  });
}

/**
 * SSE MCP client. The URL is validated through `validateHttpTarget` before
 * the transport is constructed. Both the EventSource stream and recurring
 * POSTs use `createPinnedHttpFetch`, closing the DNS validation/connect gap
 * while preserving the SDK's long-lived response handling.
 */
export async function createSseMcpClient(input: {
  url: string;
  headers?: Record<string, string>;
}): Promise<McpClient> {
  const pinned = createPinnedHttpFetch();
  try {
    await validateHttpTarget(input.url);
    const url = new URL(input.url);
    const transport = new SSEClientTransport(url, {
      requestInit: input.headers ? { headers: input.headers } : undefined,
      fetch: pinned.fetch,
      eventSourceInit: { fetch: pinned.fetch },
    });
    return buildClient(transport, { onClose: pinned.close });
  } catch (error) {
    await pinned.close();
    throw error;
  }
}

/**
 * Streamable HTTP MCP client (canonical transport per the MCP spec
 * 2025-06-18; supersedes `sse`). The URL is validated through the
 * same `validateHttpTarget` SSRF chokepoint immediately before the
 * transport opens so private-IP / localhost / link-local / metadata
 * targets are rejected up-front. Every SDK request then runs through
 * `createPinnedHttpFetch`, which revalidates and pins each connect and
 * every redirect hop.
 *
 * Wire shape: a single HTTPS endpoint that accepts JSON-RPC over POST
 * and optionally opens an SSE stream (server-to-client GET) for
 * server-initiated messages. The SDK's `StreamableHTTPClientTransport`
 * owns both halves; this factory wires the URL, headers, and secure fetch.
 */
export async function createHttpMcpClient(input: {
  url: string;
  headers?: Record<string, string>;
}): Promise<McpClient> {
  const pinned = createPinnedHttpFetch();
  try {
    await validateHttpTarget(input.url);
    const url = new URL(input.url);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: input.headers ? { headers: input.headers } : undefined,
      fetch: pinned.fetch,
    });
    return buildClient(transport, { onClose: pinned.close });
  } catch (error) {
    await pinned.close();
    throw error;
  }
}

type BuildClientHooks = {
  /** Stdio transports register their stderr capture + lifetime timer on first connect. */
  onConnect?: () => void;
  /** Release transport-specific resources after the SDK client closes. */
  onClose?: () => void | Promise<void>;
  /** Returns the sandbox snapshot for `client.getSandboxSnapshot()`. */
  snapshot?: () => SandboxClientSnapshot;
  /** Read-only view of the sandbox kill flags so we can map SDK errors. */
  sandboxStateGetter?: () => {
    lifetimeExceeded: boolean;
    stderrExceeded: boolean;
    maxLifetimeMs?: number;
    maxStderrBytes?: number;
  };
};

function buildClient(
  transport: ConstructorParameters<typeof Client>[0] extends never ? never : unknown,
  hooks: BuildClientHooks = {},
): McpClient {
  const client = new Client(
    { name: "janusly-mcp-client", version: "0.0.1" },
    { capabilities: {} },
  );
  let connected = false;
  let connectAttempted = false;
  let closed = false;

  async function ensureConnected(): Promise<void> {
    if (connected) return;
    if (closed) throw new Error("MCP client is closed");
    // The Client.connect signature accepts the Transport; we type-erase
    // here because the SDK exposes Transport via a structural interface
    // that doesn't survive `import type` in our build.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    connectAttempted = true;
    await client.connect(transport as any);
    connected = true;
    if (hooks.onConnect) hooks.onConnect();
  }

  /**
   * Map an SDK error to a typed sandbox error when the sandbox layer
   * fired. The SDK surfaces a generic transport-closed message when the
   * lifetime watchdog or stderr cap kills the child; converting it to
   * the typed error lets the executor write the right audit code.
   */
  function withSandboxMapping<T>(promise: Promise<T>): Promise<T> {
    if (!hooks.sandboxStateGetter) return promise;
    return promise.catch((err) => {
      const state = hooks.sandboxStateGetter!();
      if (state.lifetimeExceeded) {
        throw new McpSandboxLifetimeExceededError(state.maxLifetimeMs ?? 0);
      }
      if (state.stderrExceeded) {
        throw new McpSandboxStderrExceededError(state.maxStderrBytes ?? 0);
      }
      throw err;
    });
  }

  return {
    async listTools() {
      await ensureConnected();
      const result = await withSandboxMapping(client.listTools());
      const tools = Array.isArray(result.tools) ? result.tools : [];
      return tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? null,
        inputSchema:
          tool.inputSchema && typeof tool.inputSchema === "object"
            ? (tool.inputSchema as Record<string, unknown>)
            : null,
      }));
    },
    async callTool({ name, input, timeoutMs }) {
      await ensureConnected();
      const start = Date.now();
      const callPromise = withSandboxMapping(client.callTool({ name, arguments: input ?? {} }));
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error("timeout")), Math.max(1, timeoutMs));
      });
      try {
        const result = await Promise.race([callPromise, timeoutPromise]);
        const latencyMs = Date.now() - start;
        return { output: normaliseToolResult(result), latencyMs };
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        // A connect attempt may open a child process or socket before the SDK
        // rejects initialization. Close the client even when `connected` was
        // never set so partially-open transports do not leak.
        if (connectAttempted) await client.close();
      } catch {
        // Closing a partially-connected transport may throw; the caller
        // already has the error from the failed operation. Drop silently.
      } finally {
        connected = false;
        if (hooks.onClose) await hooks.onClose();
      }
    },
    getSandboxSnapshot: hooks.snapshot ? () => hooks.snapshot!() : undefined,
  };
}

/**
 * Collapse the SDK's content-array / toolResult shape into a single
 * normalised output object so workflow steps can read it uniformly.
 * The raw SDK response is preserved under `output.raw` for advanced
 * consumers that need the full shape.
 */
function normaliseToolResult(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object") return { raw: result };
  const obj = result as Record<string, unknown>;

  // Compatibility shape: `{ toolResult: ... }` (older MCP responses).
  if (obj.toolResult !== undefined) {
    return { value: obj.toolResult, raw: obj };
  }

  // Modern shape: `{ content: [...], structuredContent?, isError? }`.
  const isError = obj.isError === true;
  const structured =
    obj.structuredContent && typeof obj.structuredContent === "object" && !Array.isArray(obj.structuredContent)
      ? (obj.structuredContent as Record<string, unknown>)
      : null;
  const content = Array.isArray(obj.content) ? obj.content : [];
  const textParts: string[] = [];
  for (const part of content) {
    if (part && typeof part === "object") {
      const p = part as Record<string, unknown>;
      if (p.type === "text" && typeof p.text === "string") textParts.push(p.text);
    }
  }
  return {
    isError,
    text: textParts.length > 0 ? textParts.join("\n") : null,
    structured,
    raw: obj,
  };
}

/**
 * Convenience wrapper: open a client, run the operation, always
 * `close()` afterwards. Use when the work fits in a single async
 * scope — discovery (`listTools`) is the canonical case.
 */
export async function withMcpClient<T>(factory: () => McpClient | Promise<McpClient>, fn: (client: McpClient) => Promise<T>): Promise<T> {
  const client = await factory();
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {
      // ignore: best-effort close
    });
  }
}

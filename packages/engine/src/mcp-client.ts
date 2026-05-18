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
 *    connection to a remote MCP server. The URL is validated up-front
 *    through the same target-policy validator that backs
 *    `fetchHttpTarget`, so localhost / private-IP / link-local targets
 *    are rejected before the SDK transport is constructed. The SDK
 *    transport still owns the actual SSE fetch path.
 *  - `createHttpMcpClient({url, headers})` opens a Streamable HTTP
 *    connection (the canonical MCP transport per the June 2025 spec;
 *    supersedes SSE). Same SSRF gate as `sse`, same headers
 *    pass-through. The SDK's `StreamableHTTPClientTransport` owns the
 *    POST + optional SSE wire format.
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

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { validateHttpTarget } from "./http-policy";

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
}

/**
 * Stdio MCP client. The spawn env is a fresh object containing only
 * `PATH` (so the child can locate its own deps) plus the explicit
 * `envRefs` the admin declared on the connection. Never spread
 * `process.env` here.
 */
export function createStdioMcpClient(input: {
  command: string;
  args?: string[];
  env: Record<string, string>;
}): McpClient {
  // Whitelist the absolute minimum env. `PATH` is required so the
  // child can find node / uvx / npx binaries; everything else comes
  // from the admin's declared envRefs.
  const spawnEnv: Record<string, string> = { PATH: process.env.PATH ?? "" };
  for (const [key, value] of Object.entries(input.env)) {
    if (typeof value === "string") spawnEnv[key] = value;
  }
  const transport = new StdioClientTransport({
    command: input.command,
    args: input.args ?? [],
    env: spawnEnv,
  });
  return buildClient(transport);
}

/**
 * SSE MCP client. The URL is validated through `validateHttpTarget`'s
 * SSRF chokepoint immediately before the transport opens so private-
 * IP / localhost / link-local targets are rejected up-front.
 *
 * Known v1 limitation: the SDK's SSE transport uses Node's global
 * `fetch` (and the `eventsource` package for the server-sent-events
 * stream), neither of which goes through the pinned `undici.Agent`
 * dispatcher that `fetchHttpTarget` uses for `http` nodes +
 * `http.request` tool. The TCP connect runs a fresh DNS lookup
 * separate from `validateHttpTarget`'s validation pass, so a slow
 * DNS-rebinding attack between validation and connect (microseconds
 * apart, but not zero) could land on a private IP that validation
 * rejected. Follow-up hardening should fork the eventsource transport
 * or write a custom SSE reader that routes through the same pinned
 * dispatcher. For v1, the operator's deliberate URL registration +
 * the up-front `validateHttpTarget` call are the perimeter.
 */
export async function createSseMcpClient(input: {
  url: string;
  headers?: Record<string, string>;
}): Promise<McpClient> {
  // Reject private-IP / localhost / link-local targets before we open
  // the SSE stream. The SDK still owns the actual fetch path, so this
  // does not inherit fetchHttpTarget's pinned dispatcher.
  await validateHttpTarget(input.url);
  const url = new URL(input.url);
  const transport = new SSEClientTransport(url, {
    requestInit: input.headers ? { headers: input.headers } : undefined,
  });
  return buildClient(transport);
}

/**
 * Streamable HTTP MCP client (canonical transport per the MCP spec
 * 2025-06-18; supersedes `sse`). The URL is validated through the
 * same `validateHttpTarget` SSRF chokepoint immediately before the
 * transport opens so private-IP / localhost / link-local / metadata
 * targets are rejected up-front.
 *
 * Wire shape: a single HTTPS endpoint that accepts JSON-RPC over POST
 * and optionally opens an SSE stream (server-to-client GET) for
 * server-initiated messages. The SDK's `StreamableHTTPClientTransport`
 * owns both halves; this factory only wires the URL + headers.
 *
 * Known v1 limitation: same as `createSseMcpClient` — the SDK's HTTP
 * fetch path does NOT go through the pinned `undici.Agent` dispatcher
 * that `fetchHttpTarget` uses for `http` nodes + `http.request` tool.
 * The TCP connect runs a fresh DNS lookup separate from
 * `validateHttpTarget`'s validation pass, so a slow DNS-rebinding
 * attack between validation and connect (microseconds apart, but not
 * zero) could land on a private IP that validation rejected. Same
 * follow-up applies to both transports.
 */
export async function createHttpMcpClient(input: {
  url: string;
  headers?: Record<string, string>;
}): Promise<McpClient> {
  await validateHttpTarget(input.url);
  const url = new URL(input.url);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: input.headers ? { headers: input.headers } : undefined,
  });
  return buildClient(transport);
}

function buildClient(transport: ConstructorParameters<typeof Client>[0] extends never ? never : unknown): McpClient {
  const client = new Client(
    { name: "janusly-mcp-client", version: "0.0.1" },
    { capabilities: {} },
  );
  let connected = false;

  async function ensureConnected(): Promise<void> {
    if (connected) return;
    // The Client.connect signature accepts the Transport; we type-erase
    // here because the SDK exposes Transport via a structural interface
    // that doesn't survive `import type` in our build.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.connect(transport as any);
    connected = true;
  }

  return {
    async listTools() {
      await ensureConnected();
      const result = await client.listTools();
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
      const callPromise = client.callTool({ name, arguments: input ?? {} });
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
      if (!connected) return;
      try {
        await client.close();
      } catch {
        // Closing a partially-connected transport may throw; the caller
        // already has the error from the failed operation. Drop silently.
      }
      connected = false;
    },
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

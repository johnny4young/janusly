/**
 * Tests for the transport-agnostic MCP client wrapper. The SDK is
 * mocked so we exercise the wrapper's contract (env whitelist for
 * stdio, SSRF gate for sse, timeout race, normalised output shape)
 * without spawning a real process or opening a real socket.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stdioConstructorCalls: Array<Record<string, unknown>> = [];
const sseConstructorCalls: Array<Record<string, unknown>> = [];
const httpConstructorCalls: Array<Record<string, unknown>> = [];
const pinnedFetchHandles: Array<{
  fetch: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}> = [];
let stdioStderrStream: (NodeJS.ReadableStream & EventEmitter) | null = null;
let callToolError: Error | null = null;
let callToolGate: Promise<void> | null = null;
let connectError: Error | null = null;
let clientCloseCalls = 0;

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class FakeClient {
    constructor(public info: unknown, public options: unknown) {}
    async connect() {
      if (connectError) throw connectError;
      return;
    }
    async listTools() {
      return {
        tools: [
          { name: "echo", description: "Echo", inputSchema: { type: "object" } },
          { name: "missing", description: null, inputSchema: null },
        ],
      };
    }
    async callTool(_params: unknown) {
      if (callToolGate) await callToolGate;
      if (callToolError) throw callToolError;
      return { content: [{ type: "text", text: "ok" }], isError: false };
    }
    async close() {
      clientCloseCalls += 1;
      return;
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class StdioTransport {
    stderr = stdioStderrStream;
    constructor(params: Record<string, unknown>) {
      stdioConstructorCalls.push(params);
    }
    async close() {
      return;
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class SSETransport {
    constructor(url: URL, opts?: Record<string, unknown>) {
      sseConstructorCalls.push({ url: url.toString(), ...(opts ?? {}) });
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class HTTPTransport {
    constructor(url: URL, opts?: Record<string, unknown>) {
      httpConstructorCalls.push({ url: url.toString(), ...(opts ?? {}) });
    }
  },
}));

vi.mock("./http-policy", () => ({
  createPinnedHttpFetch: vi.fn(() => {
    const handle = {
      fetch: vi.fn(async () => new Response("ok")),
      close: vi.fn(async () => undefined),
    };
    pinnedFetchHandles.push(handle);
    return handle;
  }),
  validateHttpTarget: vi.fn(async (url: string) => {
    if (url.includes("169.254.169.254")) {
      throw new Error("private target blocked");
    }
    return url;
  }),
}));

import { createHttpMcpClient, createSseMcpClient, createStdioMcpClient, withMcpClient } from "./mcp-client";
import { McpSandboxStderrExceededError } from "./mcp-sandbox";

beforeEach(() => {
  stdioConstructorCalls.length = 0;
  sseConstructorCalls.length = 0;
  httpConstructorCalls.length = 0;
  pinnedFetchHandles.length = 0;
  stdioStderrStream = null;
  callToolError = null;
  callToolGate = null;
  connectError = null;
  clientCloseCalls = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Sandbox config used by the existing whitelist tests. Allowlist is
 * permissive so the spawn-time re-check passes; ulimit wrap is off so
 * the test passes deterministically on any platform.
 */
const TEST_SANDBOX = {
  allowedCommands: ["node", "uvx", "npx"],
  enforceLinuxUlimit: false,
};

describe("createStdioMcpClient", () => {
  it("builds the spawn env from a strict whitelist (PATH + provided refs only)", async () => {
    vi.stubEnv("PATH", "/usr/bin");
    vi.stubEnv("DATABASE_URL", "postgres://secret/db");
    const client = createStdioMcpClient({
      command: "node",
      args: ["./srv.js"],
      env: { TOKEN: "abc" },
      sandbox: TEST_SANDBOX,
    });
    expect(stdioConstructorCalls).toHaveLength(1);
    const params = stdioConstructorCalls[0]!;
    const env = params.env as Record<string, string>;
    expect(env.PATH).toBe("/usr/bin");
    expect(env.TOKEN).toBe("abc");
    expect(env.DATABASE_URL).toBeUndefined();
    // Ensure the child can't read any other process env.
    expect(Object.keys(env)).toEqual(expect.arrayContaining(["PATH", "TOKEN"]));
    expect(Object.keys(env).length).toBe(2);
    // Sandbox profile adds `cwd` + `stderr: 'pipe'` to the spawn params.
    expect(params.cwd).toBeTypeOf("string");
    expect((params.cwd as string)).toContain("janusly-mcp-");
    expect(params.stderr).toBe("pipe");
    await client.close(); // cleans up the ephemeral cwd dir.
  });

  it("can listTools through the wrapper", async () => {
    const client = createStdioMcpClient({
      command: "node",
      env: {},
      sandbox: TEST_SANDBOX,
    });
    const tools = await client.listTools();
    expect(tools).toEqual([
      { name: "echo", description: "Echo", inputSchema: { type: "object" } },
      { name: "missing", description: null, inputSchema: null },
    ]);
    await client.close();
  });

  it("rejects at spawn time when the command is not in the allowlist (defense in depth)", () => {
    // Even when the registration-time gate has passed, a tightened
    // allowlist must fail-closed at spawn time. Asserts the SDK
    // constructor is NEVER reached.
    const callsBefore = stdioConstructorCalls.length;
    expect(() =>
      createStdioMcpClient({
        command: "curl",
        env: {},
        sandbox: { allowedCommands: ["node"], enforceLinuxUlimit: false },
      }),
    ).toThrow(/not in allowlist/i);
    expect(stdioConstructorCalls.length).toBe(callsBefore);
  });

  it("exposes the sandbox snapshot for stdio transports", async () => {
    const client = createStdioMcpClient({
      command: "node",
      env: {},
      sandbox: TEST_SANDBOX,
    });
    // Touch listTools so the connect hook fires and the snapshot path
    // attaches. The mocked StdioClientTransport has no stderr stream, so
    // the snapshot starts empty.
    await client.listTools();
    const snap = client.getSandboxSnapshot?.();
    expect(snap).not.toBeNull();
    expect(snap?.capturedStderr).toBe("");
    expect(snap?.stderrTruncated).toBe(false);
    expect(snap?.lifetimeExceeded).toBe(false);
    await client.close();
  });

  it("maps stderr-cap transport closure to a typed sandbox stderr error", async () => {
    stdioStderrStream = new EventEmitter() as NodeJS.ReadableStream & EventEmitter;
    callToolError = new Error("transport closed");
    let releaseCallTool!: () => void;
    callToolGate = new Promise((resolve) => {
      releaseCallTool = resolve;
    });

    const client = createStdioMcpClient({
      command: "node",
      env: {},
      sandbox: { ...TEST_SANDBOX, maxStderrBytes: 1024 },
    });

    const pending = client.callTool({ name: "echo", input: {}, timeoutMs: 1000 });
    await Promise.resolve();
    await Promise.resolve();
    stdioStderrStream.emit("data", Buffer.from("x".repeat(2048)));
    releaseCallTool();

    await expect(pending).rejects.toBeInstanceOf(McpSandboxStderrExceededError);
    const snap = client.getSandboxSnapshot?.();
    expect(snap?.stderrExceeded).toBe(true);
    expect(snap?.stderrTruncated).toBe(true);
    await client.close();
  });
});

describe("createSseMcpClient", () => {
  it("rejects private-IP URLs at validation time before the transport opens", async () => {
    await expect(createSseMcpClient({ url: "http://169.254.169.254/sse" })).rejects.toThrow(/private/);
    expect(sseConstructorCalls).toHaveLength(0);
    expect(pinnedFetchHandles[0]?.close).toHaveBeenCalledOnce();
  });

  it("constructs the SSE transport with headers when given", async () => {
    const client = await createSseMcpClient({ url: "https://mcp.example.com/sse", headers: { Authorization: "Bearer xyz" } });
    expect(sseConstructorCalls).toHaveLength(1);
    expect(sseConstructorCalls[0]?.url).toBe("https://mcp.example.com/sse");
    const handle = pinnedFetchHandles[0]!;
    const opts = sseConstructorCalls[0] as {
      requestInit?: { headers?: Record<string, string> };
      fetch?: unknown;
      eventSourceInit?: { fetch?: unknown };
    };
    expect(opts.requestInit?.headers?.Authorization).toBe("Bearer xyz");
    expect(opts.fetch).toBe(handle.fetch);
    expect(opts.eventSourceInit?.fetch).toBe(handle.fetch);
    await client.close();
    expect(handle.close).toHaveBeenCalledOnce();
  });
});

describe("createHttpMcpClient (Streamable HTTP)", () => {
  it("rejects private-IP URLs at validation time before the transport opens", async () => {
    // SSRF gate runs BEFORE the SDK transport is constructed. If a
    // metadata endpoint URL slipped past the route-layer check, the
    // factory still rejects via `validateHttpTarget`. Same posture as
    // the sse factory — keeping the two transports symmetric matters
    // because operators may swap a deprecated sse server for its
    // Streamable HTTP successor and expect identical safety.
    await expect(createHttpMcpClient({ url: "http://169.254.169.254/mcp" })).rejects.toThrow(/private/);
    expect(httpConstructorCalls).toHaveLength(0);
    expect(pinnedFetchHandles[0]?.close).toHaveBeenCalledOnce();
  });

  it("constructs the Streamable HTTP transport with headers when given", async () => {
    // The env-ref-resolved headers (e.g. `Authorization: Bearer ...`)
    // flow through `requestInit.headers` so the remote MCP server can
    // authenticate the call. The SDK transport carries the value
    // verbatim into every POST + SSE GET it makes.
    const client = await createHttpMcpClient({
      url: "https://hosted-mcp.example.com/",
      headers: { Authorization: "Bearer xyz" },
    });
    expect(httpConstructorCalls).toHaveLength(1);
    expect(httpConstructorCalls[0]?.url).toBe("https://hosted-mcp.example.com/");
    const handle = pinnedFetchHandles[0]!;
    const opts = httpConstructorCalls[0] as {
      requestInit?: { headers?: Record<string, string> };
      fetch?: unknown;
    };
    expect(opts.requestInit?.headers?.Authorization).toBe("Bearer xyz");
    expect(opts.fetch).toBe(handle.fetch);
    await client.close();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it("omits requestInit when no headers are provided", async () => {
    // No headers → no `requestInit` object passed to the SDK. The SDK
    // owns its default fetch shape; we only set requestInit when we
    // actually have a payload to carry.
    const client = await createHttpMcpClient({ url: "https://hosted-mcp.example.com/" });
    expect(httpConstructorCalls).toHaveLength(1);
    const opts = httpConstructorCalls[0] as { requestInit?: unknown; fetch?: unknown };
    expect(opts.requestInit).toBeUndefined();
    expect(opts.fetch).toBe(pinnedFetchHandles[0]?.fetch);
    await client.close();
  });

  it("closes a partially initialized SDK client and pinned fetch after connect fails", async () => {
    connectError = new Error("initialization rejected");
    const client = await createHttpMcpClient({ url: "https://hosted-mcp.example.com/" });

    await expect(client.listTools()).rejects.toThrow(/initialization rejected/);
    await client.close();

    expect(clientCloseCalls).toBe(1);
    expect(pinnedFetchHandles[0]?.close).toHaveBeenCalledOnce();
  });
});

describe("withMcpClient", () => {
  it("runs the operation and closes the client even when fn throws", async () => {
    let closed = false;
    const factory = () => ({
      listTools: async () => [],
      callTool: async () => ({ output: {}, latencyMs: 0 }),
      close: async () => {
        closed = true;
      },
    });
    await expect(
      withMcpClient(factory, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow(/boom/);
    expect(closed).toBe(true);
  });
});

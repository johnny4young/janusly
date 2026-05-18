/**
 * Tests for the transport-agnostic MCP client wrapper. The SDK is
 * mocked so we exercise the wrapper's contract (env whitelist for
 * stdio, SSRF gate for sse, timeout race, normalised output shape)
 * without spawning a real process or opening a real socket.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stdioConstructorCalls: Array<Record<string, unknown>> = [];
const sseConstructorCalls: Array<Record<string, unknown>> = [];
const httpConstructorCalls: Array<Record<string, unknown>> = [];

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class FakeClient {
    constructor(public info: unknown, public options: unknown) {}
    async connect() {
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
      return { content: [{ type: "text", text: "ok" }], isError: false };
    }
    async close() {
      return;
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class StdioTransport {
    constructor(params: Record<string, unknown>) {
      stdioConstructorCalls.push(params);
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
  validateHttpTarget: vi.fn(async (url: string) => {
    if (url.includes("169.254.169.254")) {
      throw new Error("private target blocked");
    }
    return url;
  }),
}));

import { createHttpMcpClient, createSseMcpClient, createStdioMcpClient, withMcpClient } from "./mcp-client";

beforeEach(() => {
  stdioConstructorCalls.length = 0;
  sseConstructorCalls.length = 0;
  httpConstructorCalls.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createStdioMcpClient", () => {
  it("builds the spawn env from a strict whitelist (PATH + provided refs only)", () => {
    vi.stubEnv("PATH", "/usr/bin");
    vi.stubEnv("DATABASE_URL", "postgres://secret/db");
    createStdioMcpClient({ command: "node", args: ["./srv.js"], env: { TOKEN: "abc" } });
    expect(stdioConstructorCalls).toHaveLength(1);
    const params = stdioConstructorCalls[0]!;
    const env = params.env as Record<string, string>;
    expect(env.PATH).toBe("/usr/bin");
    expect(env.TOKEN).toBe("abc");
    expect(env.DATABASE_URL).toBeUndefined();
    // Ensure the child can't read any other process env.
    expect(Object.keys(env)).toEqual(expect.arrayContaining(["PATH", "TOKEN"]));
    expect(Object.keys(env).length).toBe(2);
  });

  it("can listTools through the wrapper", async () => {
    const client = createStdioMcpClient({ command: "node", env: {} });
    const tools = await client.listTools();
    expect(tools).toEqual([
      { name: "echo", description: "Echo", inputSchema: { type: "object" } },
      { name: "missing", description: null, inputSchema: null },
    ]);
    await client.close();
  });
});

describe("createSseMcpClient", () => {
  it("rejects private-IP URLs at validation time before the transport opens", async () => {
    await expect(createSseMcpClient({ url: "http://169.254.169.254/sse" })).rejects.toThrow(/private/);
    expect(sseConstructorCalls).toHaveLength(0);
  });

  it("constructs the SSE transport with headers when given", async () => {
    const client = await createSseMcpClient({ url: "https://mcp.example.com/sse", headers: { Authorization: "Bearer xyz" } });
    expect(sseConstructorCalls).toHaveLength(1);
    expect(sseConstructorCalls[0]?.url).toBe("https://mcp.example.com/sse");
    await client.close();
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
    const opts = httpConstructorCalls[0] as { requestInit?: { headers?: Record<string, string> } };
    expect(opts.requestInit?.headers?.Authorization).toBe("Bearer xyz");
    await client.close();
  });

  it("omits requestInit when no headers are provided", async () => {
    // No headers → no `requestInit` object passed to the SDK. The SDK
    // owns its default fetch shape; we only set requestInit when we
    // actually have a payload to carry.
    const client = await createHttpMcpClient({ url: "https://hosted-mcp.example.com/" });
    expect(httpConstructorCalls).toHaveLength(1);
    const opts = httpConstructorCalls[0] as { requestInit?: unknown };
    expect(opts.requestInit).toBeUndefined();
    await client.close();
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

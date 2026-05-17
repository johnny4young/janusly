/**
 * `@janusly/mcp-server` entry point.
 *
 * Spawned by an MCP client (typically Claude Desktop) as a stdio subprocess.
 * Reads connection config from environment variables, builds the auth-aware
 * API client, and connects the MCP `Server` to a `StdioServerTransport`.
 *
 * Lifecycle:
 *   1. `resolveApiClientConfig(process.env)` — defaults: localhost API, org
 *      `default`, user `mcp-user`, no service token.
 *   2. `createApiClient(cfg)` — closure that injects auth headers per request.
 *   3. `Server` registered with two request handlers:
 *      - `tools/list` → returns the MCP tool descriptors.
 *      - `tools/call` → dispatches to `runOne` in `./tools`.
 *   4. `await server.connect(transport)` — JSON-RPC over stdio, runs forever.
 *
 * Used by:
 * - Claude Desktop's `mcpServers` config (see `packages/mcp-server/README.md`
 *   for the snippet).
 * - `pnpm --filter @janusly/mcp-server dev` for local hacking; `start` for
 *   the production-shaped invocation Claude Desktop uses (no watch loop).
 *
 * Invariants:
 * - Top-level await is intentional: the server runs forever; if `connect`
 *   throws we want the process to exit non-zero so Claude Desktop's
 *   diagnostics panel shows the cause.
 * - `capabilities: { tools: {} }` declares we only support tools — no
 *   resources, prompts, or sampling. Adding more capabilities means new
 *   request handlers, not just flipping the flag.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createApiClient, resolveApiClientConfig } from "./api-client.js";
import { dispatchTool, tools } from "./tools.js";

const cfg = resolveApiClientConfig(process.env);
const callApi = createApiClient(cfg);

const server = new Server(
  { name: "janusly", version: "0.0.1" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return dispatchTool(callApi, name, (args ?? {}) as Record<string, unknown>);
});

const transport = new StdioServerTransport();
await server.connect(transport);

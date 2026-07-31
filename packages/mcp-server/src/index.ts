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
 *      - `tools/call` → dispatches through the stable `./tools` barrel; expected
 *        validation/API failures become `{ isError: true }` tool results.
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
 * - Janusly run ids are the durable asynchronous handle. The server does not
 *   opt into experimental MCP Tasks; agents start a run and poll `runs.status`.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createApiClient, resolveApiClientConfig } from "./api-client.js";
import { dispatchTool, toolErrorResult, tools } from "./tools.js";

export const SERVER_INSTRUCTIONS = [
  "Janusly is a durable workflow operator, not an ephemeral function runner.",
  "For a new workflow: inspect recipes/tools/connections, generate or author a DAG, call workflows.validate and workflows.readiness, then save only with operator-approved MCP writes.",
  "To execute: call runs.start, poll runs.status until terminal or waiting, and use runs.get for paginated history or runs.usage for attributed resource use.",
  "When a run fails: inspect dlq.list and reports.run_explain, request ai.patch_workflow if useful, validate and deliberately save the candidate, then call runs.redrive so the continuation uses that saved version. Use dlq.replay only for a transient or same-version exact-node retry.",
  "If the recovery circuit breaker paused a workflow, call workflows.resume and repeat only while its bounded backfill reports remaining events.",
  "Never place secret values in workflow JSON or MCP arguments. Connection envRefs contain deployment environment-variable names only.",
].join(" ");
const SERVER_VERSION = "0.0.2";

const cfg = resolveApiClientConfig(process.env);
const callApi = createApiClient(cfg);

const server = new Server(
  { name: "janusly", version: SERVER_VERSION },
  {
    capabilities: { tools: {} },
    instructions: SERVER_INSTRUCTIONS,
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    return await dispatchTool(
      callApi,
      name,
      (args ?? {}) as Record<string, unknown>,
    );
  } catch (error) {
    return toolErrorResult(error);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

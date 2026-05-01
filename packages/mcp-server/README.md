# `@janusly/mcp-server`

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server that exposes Janusly to MCP-aware AI clients (Claude Desktop, Cursor, custom agents). Five tools today; all proxy HTTP to the running Janusly API.

## What is MCP and why ship a server?

MCP is Anthropic's open protocol for letting AI assistants talk to external systems. An **MCP client** (e.g. Claude Desktop) speaks a JSON-RPC dialect over stdio or HTTP+SSE to one or more **MCP servers**. Each server advertises a list of *tools* (function-shaped capabilities); the client surfaces those in its UI and the model decides when to call them.

Janusly's strategic bet (per [`docs/PLAN.md`](../../docs/PLAN.md) §3) is that workflow engines that aren't reachable from chat-shaped assistants get bypassed. By being a first-class MCP server, a developer running Claude Desktop can ask "what workflows do I have, what tools can I call from a flow, how did `run-42` actually fail" without leaving the chat. The same surface eventually lets the assistant *author* flows ("draft a workflow that watches a webhook and posts to Slack on failure"), but that's the write path — out of scope here.

## Architecture: protocol-translation layer over the HTTP API

```
Claude Desktop                                               Janusly
──────────────                                               ───────
+------------+  stdio (JSON-RPC)  +-----------------+  HTTP   +------+   +------+
| MCP client | <----------------> |  mcp-server     | ------> | API  |-->|  DB  |
| (Anthropic |                    |  (this package) |         | (3001)   +------+
|  app)      |                    +-----------------+         +------+
+------------+                                                   ^
                                                                 |
                                                         (auth + multi-tenant
                                                          scope already lives
                                                          inside this single
                                                          chokepoint)
```

The MCP server is intentionally **not** a second consumer of the database. Every tool call is translated into an HTTP request against the existing `apps/api` server, which already enforces:

- **Auth** — dev headers (`x-org-id` / `x-user-id`) when Supabase is unset and `NODE_ENV !== "production"`, or service-token mode (`Authorization: Bearer <API_SERVICE_TOKEN>`).
- **Multi-tenant scope** — every Drizzle query carries `eq(<table>.orgId, auth.orgId)`.
- **Rate limiting** — `apps/api/src/rate-limit.ts` (Redis-backed, ENG-019) gates AI surfaces; the MCP server's read-only tools don't trip it but inherit the gating for free if we ever add AI-flavoured tools.
- **Audit logs** — write endpoints already audit; reads (the only thing this server exposes) don't.

The proxy choice is the most important architectural decision. It means:

- We don't duplicate org scope in two places (a known footgun in any system that grows a "second backend").
- Future write tools, when added, automatically inherit `requireRole`, audit, and rate-limit by going through the same API.
- The MCP server itself is small enough to fit on one screen — it's a JSON-RPC dispatcher with five `case` arms.

## Transport: stdio

MCP supports two transports: **stdio** (the server is spawned as a subprocess; client/server communicate over stdin/stdout JSON-RPC frames) and **streamable HTTP** (HTTP+SSE for long-lived sessions). Claude Desktop currently expects stdio for local servers; that's our only transport.

Boot story: Claude Desktop reads its config file (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS), spawns `pnpm --filter @janusly/mcp-server start` as a subprocess, and pipes JSON-RPC over stdio. The server stays alive as long as the parent's pipes are open; closing Claude Desktop tears the subprocess down via SIGTERM.

## The five tools

| MCP tool        | API endpoint                                                | Purpose                                                                 |
| --------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| `workflows.list`| `GET /workflows[?limit=]`                                   | List workflows in the configured org. Caps at 100 (max 200).            |
| `workflows.get` | `GET /workflows/latest?workflowId=…`                        | Fetch the latest version of one workflow. Returns null when unknown.    |
| `recipes.list`  | `GET /templates`                                            | List the built-in workflow templates (recipes).                         |
| `tools.list`    | `GET /tools`                                                | List the runtime tool catalog (`http.request`, `text.uppercase`, etc.). |
| `runs.get`      | `GET /run?runId=…[&eventsLimit=…&eventsCursor=…]`           | Fetch one run with paginated events (cap 200/500 from ENG-009).         |

Every tool returns a single MCP `text` content block carrying the API response JSON-stringified. That's the documented MCP convention for "data-shaped" results; the AI client reads it as text and reasons over it. Future tools could surface structured `resource` content blocks if the UX warrants.

## Auth flow

```
[env vars at server boot]                          [per-request]                        [Janusly API]
  JANUSLY_API_URL=…                                +------------------+                +-------------+
  JANUSLY_API_ORG_ID=default                       | mcp-server       |  HTTP request  | apps/api    |
  JANUSLY_API_USER_ID=mcp-user        ──────────►  | api-client       | ──────────────►| requireAuth |
  JANUSLY_API_SERVICE_TOKEN=<bearer>?              | injects headers  |   x-org-id     | (already    |
                                                   +------------------+   x-user-id    |  enforces   |
                                                                          Authorization?  multi-org)
                                                                                        +-------------+
```

Two modes, distinguished by whether `JANUSLY_API_SERVICE_TOKEN` is set:

- **Service-token mode (production).** The token is also configured server-side as `API_SERVICE_TOKEN`. The MCP server sends `Authorization: Bearer <token>` plus `x-org-id` / `x-user-id`. The API treats it as `mode: "service-token"` and looks up the org_member row for the role check.
- **Dev-headers mode (default for local).** No token; just `x-org-id` / `x-user-id`. The API accepts these only when Supabase is unset and `NODE_ENV !== "production"` (or `ALLOW_DEV_AUTH_HEADERS=true`).

Org scoping is **not** the MCP server's job — it's the API's. The MCP server just forwards the headers; whatever the API would have returned for that auth context is what the MCP server returns to the client.

## Configuring Claude Desktop

Drop this into `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the equivalent on your platform:

```jsonc
{
  "mcpServers": {
    "janusly": {
      "command": "pnpm",
      "args": ["--filter", "@janusly/mcp-server", "start"],
      "env": {
        "JANUSLY_API_URL": "http://127.0.0.1:3001",
        "JANUSLY_API_ORG_ID": "default",
        "JANUSLY_API_USER_ID": "mcp-user"
        // Add JANUSLY_API_SERVICE_TOKEN when running against a non-dev API.
      }
    }
  }
}
```

Restart Claude Desktop. The five tools appear in the tool picker. Make sure `pnpm dev` is running in another terminal — the MCP server proxies to `127.0.0.1:3001`.

## Boot, dev, test

```bash
pnpm --filter @janusly/mcp-server dev      # tsx watch — for local hacking
pnpm --filter @janusly/mcp-server start    # tsx — for Claude Desktop
pnpm --filter @janusly/mcp-server test     # vitest — unit tests
```

The package is a thin wrapper. Use `start` (no watch) when Claude Desktop spawns it; the watch loop adds noise + restart races to the MCP handshake.

## File layout

```
packages/mcp-server/
├── README.md            ← this document
├── package.json         ← workspace manifest; one runtime dep (@modelcontextprotocol/sdk)
├── tsconfig.json        ← extends repo base, noEmit
├── vite.config.ts       ← vitest config (node env, src/**/*.test.ts)
└── src/
    ├── index.ts         ← entry point — wires Server + StdioServerTransport
    ├── api-client.ts    ← env resolver + auth-aware fetch closure
    ├── api-client.test.ts
    ├── tools.ts         ← five Tool descriptors + dispatchTool() with switch over names
    └── tools.test.ts
```

## Adding a new (read-only) tool

1. Add a descriptor to `tools` in [`src/tools.ts`](src/tools.ts) — `name`, `description`, `inputSchema` (JSON Schema, not Zod — MCP speaks JSON Schema natively).
2. Add a `case` arm to `runOne` mapping the tool to its API URL. Use `URLSearchParams` for query strings (catches encoding bugs).
3. Add a unit test to `tools.test.ts` asserting the URL/headers shape with a `vi.fn` `callApi`.
4. Bump the package version if anything is downstream-visible.

Don't add destructive tools without first widening the AC — the read-only constraint is what makes the MCP surface safe to expose by default. A future ticket can add write tools (`runs.start`, `workflows.save`) once the UX is designed (likely with a confirmation/dry-run step).

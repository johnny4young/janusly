# `@janusly/mcp-server`

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes Janusly to MCP-aware AI clients (Claude Desktop, Cursor, custom agents). It publishes fifteen read-only tools (`workflows.list`, `workflows.get`, `workflows.versions`, `workflows.health`, `recipes.list`, `tools.list`, `runs.get`, `runs.list`, `dlq.list`, `dlq.clusters`, `recovery.metrics`, `reports.run_explain`, `ai.patch_workflow`, `workflows.validate`, `workflows.readiness`) plus a gated write surface (`workflows.save`) advertised only when explicit consent is configured. All tools proxy HTTP to the running Janusly API.

## What is MCP and why ship a server?

MCP is Anthropic's open protocol for letting AI assistants talk to external systems. An **MCP client** (e.g. Claude Desktop) speaks a JSON-RPC dialect over stdio or HTTP+SSE to one or more **MCP servers**. Each server advertises a list of *tools* (function-shaped capabilities); the client surfaces those in its UI and the model decides when to call them.

By being a first-class MCP server, a developer running Claude Desktop can ask "what workflows do I have, what tools can I call from a flow, how did `run-42` actually fail" without leaving the chat. The same surface can validate a workflow through the API, so authored flows can be checked before an operator saves them in Janusly.

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
- **Rate limiting** — `apps/api/src/rate-limit.ts` gates AI surfaces; MCP tools inherit API-side controls because the server never bypasses the HTTP layer.
- **Audit logs** — read tools and `workflows.validate` / `workflows.readiness` have no side effects. Accepted write tools (currently `workflows.save`) write an audit row through the API tagged `metadata.source: "mcp"` plus an `actor` block (`userId`, `mode`, and `serviceTokenSuffix` when service-token auth was used).

The proxy choice is the most important architectural decision. It means:

- We don't duplicate org scope in two places (a known footgun in any system that grows a "second backend").
- Future write tools must inherit `requireRole`, audit, and rate-limit by going through the same API after the consent policy exists.
- The MCP server itself stays small — it's a JSON-RPC dispatcher over named API calls.

## Transport: stdio

MCP supports two transports: **stdio** (the server is spawned as a subprocess; client/server communicate over stdin/stdout JSON-RPC frames) and **streamable HTTP** (HTTP+SSE for long-lived sessions). Claude Desktop currently expects stdio for local servers; that's our only transport.

Boot story: Claude Desktop reads its config file (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS), spawns `pnpm --filter @janusly/mcp-server start` as a subprocess, and pipes JSON-RPC over stdio. The server stays alive as long as the parent's pipes are open; closing Claude Desktop tears the subprocess down via SIGTERM.

## Published tools

| MCP tool              | API endpoint                                                | Purpose                                                                 |
| --------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| `workflows.list`      | `GET /workflows[?limit=]`                                   | List workflows in the configured org. Caps at 100 (max 200).            |
| `workflows.get`       | `GET /workflows/latest?workflowId=…`                        | Fetch the latest version of one workflow. Returns null when unknown.    |
| `workflows.versions`  | `GET /workflows/versions?workflowId=…`                      | List every saved version newest-first. Useful for rollback suggestions. |
| `workflows.health`    | `GET /workflows/health?workflowId=…`                        | Compute the 0-100 health score + 6 sub-scores for one workflow.         |
| `recipes.list`        | `GET /templates`                                            | List the built-in workflow templates (recipes).                         |
| `tools.list`          | `GET /tools`                                                | List the runtime tool catalog (`http.request`, `text.uppercase`, etc.). |
| `runs.get`            | `GET /run?runId=…[&eventsLimit=…&eventsCursor=…]`           | Fetch one run with paginated events.                                    |
| `runs.list`           | `GET /runs[?workflowId=…&limit=…]`                          | List recent runs newest-first; optional `workflowId` filter.            |
| `dlq.list`            | `GET /dlq[?status=…&limit=…]`                               | List DLQ entries newest-first; optional `status` filter.                |
| `dlq.clusters`        | `GET /dlq/clusters[?windowDays=…]`                          | Group recent failures by normalized signature (e.g. "Missing secret: GITHUB_TOKEN"). |
| `recovery.metrics`    | `GET /recovery/metrics[?windowDays=…]`                      | Org-level recovery rollup: success rate, MTTR, p95 latency, approvals pending, replay rate, cost. |
| `reports.run_explain` | `GET /reports/run-explain?runId=…&format=json`              | Structured explanation envelope for one run (root cause, failed node, recommended next action). |
| `ai.patch_workflow`   | `POST /ai/patch-workflow`                                   | Ask the AI for up to 3 suggested patches for one DLQ entry. NO save happens; review only. |
| `workflows.validate`  | `POST /validate`                                            | Validate workflow shape and graph rules without saving.                 |
| `workflows.readiness` | `POST /workflows/readiness`                                 | Pre-flight readiness check (safety / rollback / approvals / secrets).   |

`workflows.save` is the first gated write tool. It is advertised only when `JANUSLY_MCP_WRITES_ENABLED=true` is set in the MCP server's environment. The API process must also see the same env flag before it accepts the write, and the route additionally requires `org_configs.mcp.writeConsent = true` for the calling org — both gates must pass or the API returns HTTP 403 with `code: "mcp_process_disabled"` or `code: "mcp_tenant_disabled"`. The tool accepts an optional `dryRun: true` argument that routes the call to `POST /validate` (no persistence) so an MCP client can preview without writing.

| MCP tool          | API endpoint                    | Notes                                                              |
| ----------------- | ------------------------------- | ------------------------------------------------------------------ |
| `workflows.save`  | `POST /workflows/save`          | Gated by env + tenant flag; rate-limited at 60/min/org.            |
| (with `dryRun`)   | `POST /validate`                | Preview only; never persists.                                      |

The pre-flight POST tools (`workflows.validate` and `workflows.readiness`) take a workflow body and return a verdict; neither writes to the database.

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

Restart Claude Desktop. The Janusly tools appear in the tool picker. Make sure `pnpm dev` is running in another terminal — the MCP server proxies to `127.0.0.1:3001`.

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
    ├── tools.ts         ← Tool descriptors + dispatchTool() with switch over names
    └── tools.test.ts
```

## Adding a new tool

1. Add a descriptor to `tools` in [`src/tools.ts`](src/tools.ts) — `name`, `description`, `inputSchema` (JSON Schema, not Zod — MCP speaks JSON Schema natively).
2. Add a `case` arm to `runOne` mapping the tool to its API URL. Use `URLSearchParams` for query strings (catches encoding bugs).
3. Add a unit test to `tools.test.ts` asserting the URL/headers shape with a `vi.fn` `callApi`.
4. Bump the package version if anything is downstream-visible.

Write tools must go through the policy in `apps/api/src/mcp-consent.ts`. The route handler runs `isMcpWriteAllowed(auth.orgId)` (env + tenant gate), enforces a `mcp.<actionKey>` rate-limit bucket via `enforceRateLimit`, and merges `mcpAuditMetadata(auth)` into the audit row. Add a new write tool by (1) appending to `WRITE_TOOLS` in `src/tools.ts`, (2) wiring the API route through those three helpers, (3) extending the tests in `tools.test.ts` and `apps/api/src/mcp-consent.test.ts`. Do not add destructive tools without all three steps.

## Configuring MCP writes

Two flags must both be true:

1. **Process-wide:** set `JANUSLY_MCP_WRITES_ENABLED=true` in both the API and MCP server environments (the same root `.env` covers both in local dev; remote MCP deployments need the value on both processes). Default is off; an unset value, `"false"`, or any non-`"true"` string keeps writes disabled.
2. **Per tenant:** set `org_configs.mcp.writeConsent = true` for the calling org via `POST /org/config` with `{ key: "mcp.writeConsent", value: true }`. Each org opts in independently.

Both flags read together. Either being false returns HTTP 403 to the MCP client with a stable `code` field so the model can render a clear message. Forensics: every accepted MCP write writes a row to `audit_logs` with `metadata.source: "mcp"` plus an `actor` block carrying the userId, auth mode, and the last 4 chars of the service token when service-token auth was used.

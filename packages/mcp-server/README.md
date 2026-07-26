# `@janusly/mcp-server`

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes
Janusly to MCP-aware AI clients (Claude Desktop, Cursor, custom agents). It
publishes 24 always-available discovery/inspection tools and 13 write tools
advertised only when explicit consent is configured. Every tool proxies a
runtime-validated `/v1` contract on the running Janusly API.

## What is MCP and why ship a server?

MCP is an open standard for letting AI assistants talk to external systems. An
**MCP client** speaks JSON-RPC over stdio or Streamable HTTP to one or more
**MCP servers**. Each server advertises tools and their schemas; the host decides
how and when a model may call them.

By being a first-class MCP server, an external agent can discover, author,
validate, save, run, observe, resume, cancel, and recover Janusly workflows
without bypassing the API. This is **agent-complete workflow operation**, not
unrestricted platform administration: secrets, identity/membership, arbitrary
tenant configuration, deployment rollouts, and workflow trash/delete/restore
controls stay operator-owned.

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
- **Audit logs** — read tools and `workflows.validate` / `workflows.readiness` do not persist workflow state. Accepted write tools write through the API audit chokepoint, tagged `metadata.source: "mcp"` plus an `actor` block (`userId`, `mode`, and `serviceTokenSuffix` when service-token auth was used).

The proxy choice is the most important architectural decision. It means:

- We don't duplicate org scope in two places (a known footgun in any system that grows a "second backend").
- Future write tools must inherit role, permission, consent, audit, and rate-limit enforcement by going through the same API.
- The MCP server itself stays small — it's a JSON-RPC dispatcher over named API calls.

## Transport: stdio

MCP supports two transports: **stdio** (the server is spawned as a subprocess; client/server communicate over stdin/stdout JSON-RPC frames) and **streamable HTTP** (HTTP+SSE for long-lived sessions). Claude Desktop currently expects stdio for local servers; that's our only transport.

Boot story: Claude Desktop reads its config file (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS), spawns `pnpm --filter @janusly/mcp-server start` as a subprocess, and pipes JSON-RPC over stdio. The server stays alive as long as the parent's pipes are open; closing Claude Desktop tears the subprocess down via SIGTERM.

## Published tools

| MCP tool | API endpoint | Purpose |
| --- | --- | --- |
| `workflows.list` | `GET /v1/workflows` | List active workflows with bounded filters and keyset pagination. |
| `workflows.get` | `GET /v1/workflows/latest` | Fetch the latest active workflow version. |
| `workflows.versions` | `GET /v1/workflows/versions` | List immutable versions newest-first. |
| `workflows.health` | `GET /v1/workflows/health` | Compute workflow health and SLO signals. |
| `workflows.schedule_preview` | `GET /v1/workflows/schedule-preview` | Validate a cron and preview three fires. |
| `recipes.list` | `GET /v1/templates` | List built-in workflow recipes. |
| `tools.list` | `GET /v1/tools` | List the runtime tool catalog. |
| `runs.get` | `GET /v1/run` | Fetch one run with paginated events. |
| `runs.list` | `GET /v1/runs` | List recent runs with workflow, status, and run-kind filters. |
| `runs.status` | `GET /v1/status` | Poll the latest durable run state. |
| `runs.usage` | `GET /v1/run/usage` | Read attributed LLM and memory usage. |
| `dlq.list` | `GET /v1/dlq` | List bounded DLQ entries. |
| `dlq.clusters` | `GET /v1/dlq/clusters` | Group recent failures by normalized signature. |
| `memory.consent_status` | `GET /v1/memory/consent-status` | Inspect effective memory consent and purge state. |
| `recovery.metrics` | `GET /v1/recovery/metrics` | Read the tenant recovery rollup. |
| `recovery.ledger` | `GET /v1/recovery/ledger` | Read lifetime impact-bound recovery totals. |
| `recovery.my_wins` | `GET /v1/recovery/my-wins` | Read operator-attributed recent recoveries. |
| `reports.run_explain` | `GET /v1/reports/run-explain` | Explain one run with structured evidence. |
| `ai.patch_workflow` | `POST /v1/ai/patch-workflow` | Suggest patches without saving a workflow version. |
| `ai.generate_workflow` | `POST /v1/ai/generate-workflow` | Generate a workflow suggestion without saving it. |
| `workflows.validate` | `POST /v1/validate` | Validate workflow shape and graph rules without saving. |
| `workflows.readiness` | `POST /v1/workflows/readiness` | Evaluate safety, rollback, approval, and secret readiness. |
| `mcp.connections.list` | `GET /v1/mcp/connections` | List outbound MCP connections and tool counts. |
| `mcp.connections.tools` | `GET /v1/mcp/connections/{alias}/tools` | List cached descriptors for one connection. |

Write tools are advertised only when `JANUSLY_MCP_WRITES_ENABLED=true` is set in the MCP server environment. The API independently requires the same process flag and `org_configs.mcp.writeConsent = true` for the calling organization. Either gate being false returns HTTP 403 with `mcp_process_disabled` or `mcp_tenant_disabled`.

| MCP tool | API endpoint | Notes |
| --- | --- | --- |
| `workflows.save` | `POST /v1/workflows/save` | Save a workflow version; `dryRun: true` uses `/v1/validate` instead. |
| `workflows.rollback` | `POST /v1/workflows/rollback` | Append a prior DAG as the new latest version. |
| `workflows.resume` | `POST /v1/workflows/{workflowId}/resume` | Clear only a recovery-circuit pause and backfill buffered triggers. |
| `runs.start` | `POST /v1/start` | Start a production run. |
| `runs.resume` | `POST /v1/resume` | Resume a waiting approval or human-form node. |
| `runs.redrive` | `POST /v1/runs/redrive` | Continue a failed saved-workflow run on the latest or an explicit saved version. |
| `runs.cancel` | `POST /v1/run/cancel` | Cancel an in-flight run. |
| `dlq.replay` | `POST /v1/dlq/replay` | Retry one dead letter on the original run snapshot. Requires `deadLetterId` from `dlq.list`. |
| `mcp.connections.create` | `POST /v1/mcp/connections` | Register and discover an outbound connection. |
| `mcp.connections.update` | `POST /v1/mcp/connections/{alias}` | Update an outbound connection's safe settings. |
| `mcp.connections.rediscover` | `POST /v1/mcp/connections/{alias}/rediscover` | Refresh cached descriptors while preserving opt-ins. |
| `mcp.connections.set_tool` | `POST /v1/mcp/connections/{alias}/tools/{toolName}` | Update enabled, write-side, exposure, or rate-limit flags. |
| `mcp.connections.delete` | `DELETE /v1/mcp/connections/{alias}` | Delete a connection and its cached descriptors. |

The pre-flight POST tools (`workflows.validate` and `workflows.readiness`) take a workflow body and return a verdict; neither writes to the database.

Every tool declares a closed input schema, a generic output schema, and MCP risk
annotations. Successful calls return both a compatible JSON `text` block and
`structuredContent: { result }`. Stable `/v1` envelopes are validated and
unwrapped first, so the model receives operation data rather than transport
metadata. Expected input/API failures return `isError: true` tool results
instead of escaping as JSON-RPC internal errors.

The always-visible AI and report tools are not mislabeled as read-only: they
create audit/usage evidence and AI calls consume budget, so their
`readOnlyHint` and `idempotentHint` are false even though they never save a
workflow version.

The initialization instructions teach the durable sequence: discover → author
→ validate/readiness → save → start → poll → inspect/recover. Janusly run IDs
remain the asynchronous authority; the server intentionally does not duplicate
them into the still-experimental MCP Tasks utility.

For recovery, the distinction is deliberate: after an AI or human patch is
validated and saved, call `runs.redrive` so the continuation uses that saved
version. Use `dlq.replay` only for a transient or same-version exact-node retry.
When `workflows.resume` reports `remaining > 0`, repeat it to drain the next
bounded buffered-trigger page.

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

The package is a thin wrapper. Use `start` (no watch) when an MCP host spawns it;
the watch loop adds noise and restart races to the handshake.

## File layout

```
packages/mcp-server/
├── README.md            ← this document
├── package.json         ← workspace manifest; MCP SDK + shared path/status catalogs
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

1. Add a descriptor to the appropriate catalog in
   [`src/tools.ts`](src/tools.ts)—`name`, `description`, and `inputSchema`
   (JSON Schema, not Zod). Shared decoration adds the closed top-level schema,
   output schema, and annotations; update the risk sets when the defaults are
   not accurate.
2. Add a `case` arm to `runOne` mapping the tool to its API URL. Use `URLSearchParams` for query strings (catches encoding bugs).
3. Add a unit test to `tools.test.ts` asserting the URL/headers shape with a `vi.fn` `callApi`.
4. Use the path/status constants from `@janusly/shared`; the backing route must
   have an explicit Zod contract in `V1_CONTRACT_ROUTES`.
5. Bump the package version if anything is downstream-visible.

Write tools must go through `guardMcpWrite(auth, actionKey)` in `apps/api/src/mcp-consent.ts`; that chokepoint applies the process flag, tenant consent, and per-tool rate limit for MCP-source traffic. Route audits use `auditAction`, which derives the MCP source and actor metadata. Add a write tool by extending `WRITE_TOOLS`, adding a `requireWrites`-guarded dispatch branch, guarding the backing API route, and covering both env-off refusal and env-on dispatch. Do not add destructive tools without all of those controls.

The complete boundary, lifecycle rationale, protocol contract, and deliberate
non-goals live in
[`docs/architecture/mcp-server.md`](../../docs/architecture/mcp-server.md).

## Configuring MCP writes

Two flags must both be true:

1. **Process-wide:** set `JANUSLY_MCP_WRITES_ENABLED=true` in both the API and MCP server environments (the same root `.env` covers both in local dev; remote MCP deployments need the value on both processes). Default is off; an unset value, `"false"`, or any non-`"true"` string keeps writes disabled.
2. **Per tenant:** set `org_configs.mcp.writeConsent = true` for the calling org via `POST /org/config` with `{ key: "mcp.writeConsent", value: true }`. Each org opts in independently.

Both flags read together. Either being false returns HTTP 403 to the MCP client with a stable `code` field so the model can render a clear message. Forensics: every accepted MCP write writes a row to `audit_logs` with `metadata.source: "mcp"` plus an `actor` block carrying the userId, auth mode, and the last 4 chars of the service token when service-token auth was used.

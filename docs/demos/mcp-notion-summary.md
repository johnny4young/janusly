# Demo: MCP Notion → AI summary → Slack

**Template:** [`mcp-notion-summary`](../../apps/api/src/templates.ts)
**Audience:** AI builders, ecosystem buyers, technical architects evaluating MCP
**Time:** 3-5 minutes
**Story:** "Janusly consumes external MCP servers as workflow steps. Wire a Notion MCP connection once in the admin panel, and every workflow in your org can read Notion pages with the same observability, audit, and cost story as native tools."

## Setup

| Need | How |
| --- | --- |
| `slack_webhook` credential | AI Studio → Credentials → New, kind `slack_webhook`, name `team-slack`. |
| MCP connection — alias `notion-demo` | **Critical setup step.** Admin → MCP panel → New connection: alias `notion-demo`, transport `stdio` (or `http` / `sse`), command/URL pointing at a Notion MCP server. Confirm the connection lands `active`. The descriptor for `pages.read` must be `enabled: true`. |
| Process env | `JANUSLY_MCP_ALLOWED_COMMANDS` must include the Notion MCP command if using stdio transport — fail-closed gate. |
| Sample webhook payload | `{ "pageId": "abc123def456" }` — a real Notion page id from your workspace. |

## Run sequence

1. AI Studio → Templates → click **MCP Notion → AI summary → Slack**. The 4-node DAG renders: `trigger` (webhook) → `read_page` (mcp_tool, alias `notion-demo`) → `summarize` (ai) → `notify` (slack.post tool).
2. **Save** → **Run** with the sample payload.
3. Timeline walks through:
   - `webhook.received` with the page id.
   - `mcp_tool.started` with `connectionAlias: "notion-demo"`, `toolName: "pages.read"`, the input parameters, and the timeout (30s default).
   - `mcp_tool.completed` with the result — the Notion page's content in JSON.
   - `ai.completed` — 3-5 bullet summary covering action items and decisions.
   - `tool.completed` (slack.post) — the team Slack channel pings.

## Observability story

- **Run timeline** captures the MCP call's latency, the connection alias used, the tool invoked, and the response shape. The Notion page content is captured inline; the AI summary builds on it; the Slack post wraps it.
- **Audit log** records `workflow.saved`, `workflow.started`, `tool.executed` (twice — mcp + slack). The MCP call also writes its own audit row if the connection requires write consent (read-only tools don't).
- **Usage events** records `tool.mcp.notion-demo.pages.read` (with success/failure and latency) AND `llm.completion` AND `tool.slack.post`. The MCP cost is attributed to the connection's billing tier (when configured); the AI cost goes through the usual budget gate.
- **MCP connection panel** surfaces every tool descriptor's per-call rate limit, recent error rate, and the `enabled` / `exposeToAi` flags. Operators can throttle a specific tool or revoke the connection in one click.

## Human-in-the-loop story

For a "human approves before notifying" upgrade, wire an `approval` node between `summarize` and `notify`. The human reads the AI summary in the approval prompt and decides whether the page summary is worth Slack-pinging the team. The approval decision is captured in the audit log.

## Recovery story

Three failure modes worth surfacing:

- **MCP connection unreachable** — the stdio process exits, the HTTP endpoint 503s, the SSE stream disconnects. The `mcp_tool` node returns `{ ok: false, error }`; the workflow run lands `failed` on that node. DLQ surfaces it; Recovery Queue offers `add_retry` (transient) or `swap_connection` (alias points at a different connection).
- **Tool descriptor disabled** — the admin disabled `pages.read` after the workflow was saved. The mcp_tool node returns `{ ok: false, error: "tool disabled" }`. Recovery suggests enabling the descriptor or routing to a different tool.
- **Rate limit hit** — the per-tool bucket fired. The mcp_tool node returns `{ ok: false, error: "Rate limit exceeded" }`. Recovery suggests raising `rate_limit_per_min` on the descriptor or routing to a different tool.

## Closing metric

**Time-to-integration with a new MCP server.** Wiring a Notion / Linear / Jira / custom MCP server is one admin-panel form. Once it's added, EVERY workflow in the org can call it — no per-workflow credential plumbing, no per-workflow rate-limit setup. The number to track: minutes from "we want to consume X via MCP" to "the workflow is shipping in production."

## 3-5 minute talk track

> **(0:00–0:30, the pitch)**
> The Model Context Protocol is becoming the way AI systems talk to external services. Janusly is an MCP CLIENT — we consume MCP servers as workflow steps with the same observability, audit, and cost story as our native tools.
>
> **(0:30–1:30, the setup beat)**
> Here's the admin MCP panel. I've already wired a Notion MCP server with alias `notion-demo`. The descriptors for `pages.read` and `pages.search` are enabled; `pages.update` is intentionally NOT exposed. Per-tool rate limits, per-connection write consent, all admin-controlled.
>
> **(1:30–2:30, the happy path)**
> Now I run the workflow. Webhook with a Notion page id. The mcp_tool node calls `notion-demo.pages.read` with the page id as input. Notion returns the content. AI summarizes. Slack posts the summary to the team channel. Four nodes, one external system, full observability.
>
> **(2:30–3:30, the ecosystem story)**
> This is what makes Janusly an AI platform, not an automation builder. Wire a Notion connection once — every workflow in your org gets Notion. Wire a Linear connection — every workflow gets Linear. The MCP ecosystem is the integration ecosystem; we give you the workflow primitives on top.
>
> **(3:30–4:30, the close)**
> One admin panel form, every workflow gets a new capability. The cost is gated; the writes are consented; the audit is complete. Time-to-integration with a new tool — minutes, not weeks.

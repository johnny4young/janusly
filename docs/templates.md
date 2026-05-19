# Templates

Janusly ships with a built-in catalog of starter workflows. Pick one in AI Studio → **Templates** to load its DAG onto the canvas, edit any node you want, then **Save** — the template becomes a normal saved workflow in your org. The template itself is immutable code (ships with each Janusly release); your saved workflow is your own from that moment on. Updates to a template's source never propagate to workflows you've already cloned.

The catalog is served by `GET /templates` and the data lives in [`apps/api/src/templates.ts`](../apps/api/src/templates.ts).

Each template entry carries:

| Field | Purpose |
| --- | --- |
| `id` | Stable identifier. Used as the deterministic eval fallback. Don't rename — bookmarks + eval cases depend on it. |
| `name` | Human-readable label rendered in the panel. |
| `description` | One-line summary of when to use it. |
| `category` | Display group (`AI`, `Data`, `Human-in-the-loop`, `Operations`, `Revenue`, …). |
| `requiredCredentials` | Closed list of `credentials.kind` values an operator needs configured before the run will succeed. Informational only — runtime enforces credential presence per-tool. |
| `workflow` | Full `Workflow` DAG, parsed through `WorkflowSchema` at boot. |

## Catalog

### `http-ai-summary` — HTTP → AI Summary (AI)

Call an API and summarize the response with an AI step.

- **Required credentials:** none.
- **Inputs:** none — operator can edit the `http` node's URL before running.
- **Expected output:** `summary` node's `output.response` carries the AI text. The HTTP node's body lands in `context.api.output.body` and is interpolated into the prompt.
- **Failure path:** if the AI provider key is missing or quota is exhausted, the `ai` node returns `{ mode: "fallback", aiError, response: <deterministic stub> }` (the existing AI fallback contract). The workflow still reaches `succeeded`.

### `api-transform-tool` — API → Transform → Tool (Data)

Fetch data, map outputs, and run a backend tool (`text.uppercase` by default).

- **Required credentials:** none.
- **Inputs:** none.
- **Expected output:** `tool` node returns `{ tool, result: { value: "STATUS 200" } }` (assuming the default URL).
- **Failure path:** if the HTTP node's URL is unreachable or returns a non-2xx, the runtime retries per the workflow's retry policy then surfaces a DLQ row.

### `approval-gate` — Human Approval Gate (Human-in-the-loop)

Pause execution at an approval node; resume manually via `POST /resume`.

- **Required credentials:** none.
- **Inputs:** none.
- **Expected output:** the run stays `waiting` until an operator approves. After resume, the `done` noop succeeds and the run is `succeeded`.
- **Failure path:** if the run is cancelled before approval, the `approval` node ends `cancelled` and downstream nodes never queue.

### `incident-triage` — Incident triage → GitHub + Slack (Operations)

Webhook → AI summarize → GitHub issue → Slack notify. Was the proof-of-concept for the integration tools (ENG-070).

- **Required credentials:** `github_token`, `slack_webhook`.
- **Inputs:** consumed from the inbound webhook payload — `{ alertName, … }`.
- **Expected output:** a GitHub issue with the AI-generated body and a Slack message linking to it.
- **Failure path:** any tool failure (`ok: false`) is captured in the node's `state_json.output.result` envelope. The workflow continues to the next node by default; wire a `condition` after each tool if you want to halt-on-failure.

### `customer-escalation-router` — Severity-routed customer escalation (Operations)

Webhook → AI classifies severity → condition-guarded edges fan out to one of three branches: low (Slack ping), medium (GitHub issue + Slack), or high (human review + GitHub issue + urgent Slack alert). The branch selection rides on `context.classify.output.response === "low" | "medium" | "high"`; other branches are skipped by the runtime's edge-condition guard.

- **Required credentials:** `slack_webhook`, `github_token`.
- **Inputs schema:**
  ```jsonc
  {
    "customer": "acme-co",
    "complaint": "Login broken since this morning, our whole team is locked out."
  }
  ```
- **Expected output:**
  - Low → `low_notify` posts a Slack message; medium + high branches are skipped.
  - Medium → `med_track` creates a GitHub issue, `med_notify` posts the issue URL in Slack; low + high branches are skipped.
  - High → `high_review` pauses for a human form (`responseSummary` + `owner`); on submit, `high_track` files the issue and `high_notify` posts an urgent Slack alert; low + medium branches are skipped.
- **Failure path:** if the AI classification step fails (no provider key) the response is a fallback stub that won't match any of the three keywords — all branches are skipped and the workflow ends as `skipped`. If a tool 4xx's, the envelope's `ok: false` lands in the node state but the next node in the same branch still runs (each branch is linear after the classification). Note: Janusly's `router` node is for cost/latency-based routing across equivalent candidates; for AI-keyword routing like this template, condition-guarded edges from the AI node directly is the right primitive.

### `lead-enrichment-handoff` — Lead enrichment → sales handoff (Revenue)

Webhook → AI scores → condition routes qualified leads to Slack + welcome email; unqualified leads receive a nurture-sequence email.

- **Required credentials:** `slack_webhook`. Email goes through the configured mailer (Resend / SendGrid via `email.send`) so an email provider key in env (`RESEND_API_KEY` etc.) is needed for real delivery; with the `noop` provider you'll get an audit row without a real send.
- **Inputs schema:**
  ```jsonc
  {
    "email": "leah@example.com",
    "company": "Example Co",
    "role": "VP Engineering",
    "teamSize": 12
  }
  ```
- **Expected output:**
  - Qualified → Slack pings the sales channel AND welcome email is sent to the lead.
  - Unqualified → nurture email is sent; Slack is silent.
- **Failure path:** the AI output is brittle to format drift — the condition compares the literal string `"qualified"`. If the model returns `"Qualified."` or trailing whitespace, the condition flips to false. Tighten the prompt or insert a `transform` node to normalize before flipping to production.

### `refund-triage-approval` — Refund triage → approval → billing webhook (Revenue)

Webhook → AI summarizes the claim → human approval → signed `webhook.send` to the billing system → confirmation email to the customer.

- **Required credentials:** `webhook_secret` for the HMAC-signed outbound POST. Email provider key in env for real delivery.
- **Inputs schema:**
  ```jsonc
  {
    "customer": "leah@example.com",
    "orderId": "ord_8421",
    "amountUsd": 49.00,
    "reason": "Charged twice"
  }
  ```
- **Expected output:** approval pauses the run; once approved, the billing webhook receives a JSON payload + `X-Janusly-Signature: t=<unix>,v1=<hmac-sha256-hex>` over `<timestamp>.<body>`. The customer email confirms the refund.
- **Failure path:** if the approval is rejected (use `POST /resume` with a rejection payload — currently the engine treats any resume as approval; see ENG-033 follow-up), the downstream branch fires. The signed-webhook step returns `ok: false` on a non-2xx from the billing system; the email step still runs and confirms what was attempted. Pair with a downstream `condition` if you want strict halt-on-failure.

### `ai-support-draft-review` — AI support draft → human review → send (Revenue)

Webhook → AI drafts a customer reply → `human_form` for a human agent to edit and approve → `email.send` delivers the final reply.

- **Required credentials:** none for the runtime (no integration tool with a credential kind). Email provider key in env for real delivery.
- **Inputs schema:**
  ```jsonc
  {
    "customer": "leah@example.com",
    "subject": "Question about pricing",
    "question": "What's the price for 50 seats vs 100 seats?"
  }
  ```
- **Expected output:** the human form pauses with the AI-drafted body pre-filled; the agent edits, picks a tone, submits, and the final reply is sent.
- **Failure path:** if the AI draft fails (no provider key), the human form still opens — just with a fallback stub in the `finalBody` default. The human agent always gets the chance to write the final text.

### `churn-risk-weekly-digest` — Scheduled weekly digest (Revenue)

`schedule` (Mondays 9am) → `http` fetch at-risk users → AI ranks → Slack digest in the customer-success channel.

- **Required credentials:** `slack_webhook`.
- **Inputs:** none — the schedule trigger fires on cron.
- **Expected output:** every Monday at 9am, a Slack message with a top-5 ranking of at-risk customers and one-line recommended actions per row.
- **Failure path:** if the HTTP analytics endpoint is unreachable, the AI step receives an empty body and produces a fallback message. If the Slack post fails (rate limit / bad credential), the run lands `failed` for that node; the next Monday's run still fires per the cron.

### `failed-workflow-recovery` — Failed workflow recovery → DLQ → patch → replay (Operations)

`webhook` → `http` POST write-side (NO approval upstream, `Authorization: Bearer {{secret.BILLING_API_KEY}}` with the secret intentionally unbound) → `email.send` confirmation. The headline recovery demo — the run fails on the http node and the Recovery Center surfaces two suggestions (structural insert-approval + config swap_secret_ref). See [`docs/demos/failed-workflow-recovery.md`](demos/failed-workflow-recovery.md) for the full narrative.

- **Required credentials:** none. The secret is intentionally unbound so the demo failure fires.
- **Inputs schema:**
  ```jsonc
  {
    "customer": "leah@example.com",
    "amountUsd": 49.00
  }
  ```
- **Expected output:** the workflow run lands `failed` on `charge` with a DLQ row whose `errorJson.message` is `Missing secret: BILLING_API_KEY`. Failure clustering normalizes that to `Missing secret: BILLING_API_KEY`. `/workflows/readiness` also reports `sensitive_action_missing_approval` for this workflow.
- **Failure path:** this template IS the failure path. The Recovery Queue opens; the AI suggests inserting an `approval` node upstream of the http call (structural) AND swapping the secret reference to a real secret reference (config). Sandbox validation can prove the structural patch because dry-run skips the write-side POST. A live success replay requires the operator to also point the placeholder `billing.example.com` URL at a reachable billing sandbox.

### `monthly-report-pdf` — Monthly metrics report → PDF → email (Operations)

`schedule` (cron `0 9 1 * *` — 1st of each month at 9am) → `http` fetch metrics → AI summarize → `pdf.generate` → `email.send`. Showcases schedule + http + ai + pdf + email in a single workflow. See [`docs/demos/monthly-report-pdf.md`](demos/monthly-report-pdf.md) for the narrative.

- **Required credentials:** none (mailer + object store come from env).
- **Inputs:** none — the schedule trigger fires on cron.
- **Expected output:** every month at 9am on the 1st, a PDF lands in the configured object store (S3 / local / noop) and an email goes out to `ops@example.com` with the PDF link.
- **Failure path:** with the checked-in placeholder `analytics.example.com` URL, the http node can fail before downstream AI/PDF/email steps run; the run then lands in DLQ on `fetch_metrics`. Once the operator points the URL at a reachable analytics sandbox, PDF/email failures remain tool-envelope failures that are visible in node output and should be handled by downstream conditions when the demo needs branch-specific recovery.

### `multi-agent-decision` — Multi-agent decision support (AI)

`webhook` → `multi_agent` (3 sequential agents: optimist + skeptic + arbiter) → `email.send` with the final recommendation. Showcases the multi-agent debate primitive. See [`docs/demos/multi-agent-decision.md`](demos/multi-agent-decision.md) for the narrative.

- **Required credentials:** none.
- **Inputs schema:**
  ```jsonc
  {
    "proposal": "Replace our self-hosted Postgres with a managed RDS instance for the analytics database."
  }
  ```
- **Expected output:** the arbiter's `finalAnswer` is the 3-sentence final recommendation, mailed to `decisions@example.com` with the full debate context.
- **Failure path:** without an LLM key, each agent's LLM call returns `{ mode: "fallback", aiError, response: <stub> }`. The agents still complete, the arbiter still writes (a stub) final answer, the email still sends. The AI fallback contract guarantees the workflow reaches `succeeded` even without a real LLM.

### `mcp-notion-summary` — MCP Notion → AI summary → Slack (AI)

`webhook` → `mcp_tool` (alias `notion-demo`, tool `pages.read`) → AI summarize → `slack.post` notify. Showcases Janusly as an MCP client. See [`docs/demos/mcp-notion-summary.md`](demos/mcp-notion-summary.md) for the narrative.

- **Required credentials:** `slack_webhook`.
- **Setup prerequisite:** an MCP connection with alias `notion-demo` must be wired in the admin MCP panel before running. The `pages.read` tool descriptor must be `enabled: true`. Without the connection, the mcp_tool node returns `{ ok: false, error: "connection not found" }` and the workflow lands `failed` on `read_page`.
- **Inputs schema:**
  ```jsonc
  {
    "pageId": "abc123def456"
  }
  ```
- **Expected output:** a Slack message in the team channel with a 3-5 bullet summary of the Notion page's action items and decisions.
- **Failure path:** mcp_tool failures (connection unreachable, descriptor disabled, rate limit hit) return `{ ok: false, error }` and the run lands `failed`. The Recovery Queue offers `add_retry` (transient) or `swap_connection` (alias points at a different connection).

### `bulk-classify-loop` — Bulk customer classify → digest email (Data)

`webhook` (batch of customers) → `loop` normalize per-customer summary lines → AI classify the entire batch in one grouped call → `email.send` digest. Showcases the loop primitive for fan-out aggregation and the scale-tier cost story. See [`docs/demos/bulk-classify-loop.md`](demos/bulk-classify-loop.md) for the narrative.

- **Required credentials:** none.
- **Inputs schema:**
  ```jsonc
  {
    "customers": [
      { "id": "c1", "email": "leah@example.com", "plan": "free" },
      { "id": "c2", "email": "max@example.com", "plan": "team" }
    ]
  }
  ```
- **Expected output:** an email to `success@example.com` with a ranked list of customers and one-line reasoning per row.
- **Failure path:** empty `customers` array → AI produces a fallback "no customers to classify" digest and the email still sends. Item shape drift (missing fields) → loop leaves placeholders intact in the rendered template; the AI sees the broken placeholder verbatim and classification quality drops. Recovery is upstream: validate the input schema at the webhook trigger.

## Adding a new template

1. Append an entry to `workflowTemplates` in `apps/api/src/templates.ts`. The minimum shape:
   ```ts
   {
     id: "my-new-template",
     name: "My new template",
     description: "When you'd use it",
     category: "Operations",
     requiredCredentials: ["slack_webhook"],
     workflow: { dslVersion: "1.0", id: "my-new-template", nodes: [...], edges: [...] },
   }
   ```
2. If the template references integration tools (`slack.post`, `github.create_issue`, `webhook.send`), list every matching `credentials.kind` in `requiredCredentials` — the test in `apps/api/src/templates.test.ts` enforces this.
3. Add an entry to `evals/generate-workflow.jsonl` with `fallbackTemplate: "<id>"` so the eval harness has a deterministic shape check.
4. Add a section to this document describing the inputs, expected output, and failure path.
5. Run `pnpm --filter @janusly/api test` — the templates test parses the new entry through `WorkflowSchema` + `validateWorkflow`, asserts node id uniqueness, and cross-checks every `tool` node's `config.tool` against the registered catalog from `listTools()`.

Templates are copy-on-use. They aren't versioned, aren't linked back to the workflows they spawn, and aren't editable from the UI — they're release-shipped starter packs.

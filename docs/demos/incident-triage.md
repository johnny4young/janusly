# Demo: Incident triage

**Template:** [`incident-triage`](../../apps/api/src/templates.ts)
**Audience:** SRE, on-call, operations engineering managers
**Time:** 3-5 minutes
**Story:** "When PagerDuty wakes someone up at 2am, Janusly already filed the GitHub issue and posted the Slack ping. Here is what the operator sees, what the audit trail captures, and what happens when an integration rate-limits us."

## Setup

| Need | How |
| --- | --- |
| `github_token` credential | AI Studio → Credentials → New, kind `github_token`, name `bot-github`. The token's secret material lives in env (`GITHUB_TOKEN_BOT`); the credential row stores only the env-var name and the org-scoped identifier. |
| `slack_webhook` credential | Same flow, kind `slack_webhook`, name `incidents-slack`. The webhook URL lives in env (`SLACK_WEBHOOK_INCIDENTS`). |
| Sample incident payload | `{ "alertName": "API p95 above 800ms", "service": "checkout-api", "severity": "high", "summary": "Checkout p95 latency exceeded 800ms for 10 consecutive minutes" }` |
| Optional: Github repo `janusly/incidents` you can write to | The template targets that repo by default; edit the `github_issue` node's `owner`/`repo` in the Inspector to match yours. |

## Run sequence

1. AI Studio → Templates → click **Incident triage → GitHub + Slack**. The 4-node DAG renders on canvas: `trigger` (webhook) → `summarize` (ai) → `github_issue` (tool) → `slack_notify` (tool).
2. Click **Save**. The workflow lands in the operator's org as a normal saved workflow.
3. Click **Run** with the sample payload pasted into the trigger input.
4. The timeline walks through each node in real time: `webhook.received` → `ai.completed` (with the AI's 2-3 sentence summary visible) → `tool.completed` for the GitHub issue (issue URL surfaces in the node output) → `tool.completed` for Slack.
5. Open the Slack channel — the on-call ping is live with a link to the freshly-created GitHub issue.

## Observability story

- **Run timeline** shows every node's start / end / duration / output. The AI summary is captured inline; the GitHub issue URL is captured inline; the Slack post's HTTP status code is captured inline.
- **Audit log** records `workflow.saved`, `workflow.started`, `tool.executed` (twice — github + slack). Compliance buyers care about this row-per-action audit.
- **Usage events** records `llm.completion` with token counts and the LLM cost in USD, plus `tool.github.create_issue` and `tool.slack.post` with latency.
- **Budget dashboard** (Recovery Center → Budget tile) shows MTD spend for this workflow's AI usage alongside its sibling demos.

## Human-in-the-loop story

The default `incident-triage` flow runs unattended — that is the point at 2am. For human-gated severity, the sibling [`customer-escalation-router`](../templates.md#customer-escalation-router--severity-routed-customer-escalation-operations) template upgrades the same pattern: AI classifies severity, condition-guarded edges fan to `low` (Slack ping), `medium` (Slack + GitHub), or `high` (HUMAN form + Slack + GitHub). Mention this as the "we have an opinion about when the human should be in the loop" beat.

## Recovery story

The demo's recovery angle is the one nobody plans for: "what if Slack rate-limits us mid-incident?" In live demo mode, you can simulate this by editing the `incidents-slack` credential's webhook URL to point at an unreachable host, then rerunning. The Slack node returns `{ ok: false, statusCode: 429, error }` — the workflow does NOT halt; it just records the failure in the run timeline and the operator sees the red badge in the node card. From there:

- The DLQ row is one click away in the Recovery Queue.
- The Recovery dialog suggests `fix_url` (replace the broken host) or `add_retry` (Slack throttling is transient — retry with backoff).
- Sandbox validation re-runs only the Slack post against the fixed credential.
- Replay restores the run; the GitHub issue is unchanged because we recover only the failed leaf.

## Closing metric

**Mean Time To Recovery for failed Slack pings, before vs after Janusly.** A typical operator-driven recovery (find the failed alert, manually file the GitHub issue, paste the link into Slack) is 4-8 minutes. Janusly's auto-recover loop is under 60 seconds end-to-end including the operator picking the suggestion.

## 3-5 minute talk track

> **(0:00–0:30, problem framing)**
> When an incident fires, we lose minutes filing the ticket, finding the right Slack channel, paging the on-call. Multiply by every incident this quarter — that's headcount you're paying to do paperwork.
>
> **(0:30–1:30, the happy path)**
> Here is a Janusly workflow that does it for you. Webhook receives the alert. AI summarizes it in two sentences — not boilerplate, actual context from the payload. GitHub gets a tracking issue. Slack gets the ping with the issue link. Three integrations, one approval-free flow, fully audited.
>
> **(1:30–2:30, observability)**
> Here's the timeline — every node's input and output is captured. The audit log row-per-action is what your compliance team will ask for. The usage dashboard shows the AI cost in dollars; the budget cap will throttle this workflow if it ever runs hot.
>
> **(2:30–3:30, the recovery angle)**
> Now watch what happens when Slack rate-limits us. The flow doesn't crash — it captures the failure, the Recovery Queue offers a one-click fix, sandbox validation runs, and we're back to green. From "Slack is down" to "Slack is fixed" — under a minute, no operator paged.
>
> **(3:30–4:30, the close)**
> Three integrations, one flow, the audit trail your security team wants, and a recovery story your on-call team will love. The number we track for you is Mean Time To Recovery — and this demo just took ours from minutes to seconds.

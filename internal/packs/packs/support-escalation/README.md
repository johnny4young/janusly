# Support escalation

When a support ticket comes in, this pack summarizes it with AI, lets a human agent
review and edit the reply, escalates to the support channel, and emails the customer
back.

## Flow

`webhook_received` → `ai` (schema-validated summary + draft) → `human_form` (agent review) → `slack.post` (escalate) → `email.send` (reply)

Send authenticated events to `POST /triggers/webhook/ingest` with
`endpointKey: "support-escalation"`, a stable support-system `eventId`, and
the ticket fields under `payload`. Retried deliveries converge on one run, and
duplicate endpoint keys fail closed with HTTP 409.

## What you must provide

| Credential / config | Kind | Why |
| --- | --- | --- |
| `support_slack` | `slack_webhook` | Escalates the ticket to your support channel |
| `email.from` | org config | Sender address used to reply to the customer |

Installing the pack never creates these — wire the credential in the Credentials
panel and set `email.from` in Operations → org config. `email.send` uses your
configured mailer provider, not a per-tool credential.
Configure the supported Anthropic provider so the review form can be prefilled
from the schema-validated `draftReply` field.

## Try it

- **Preview sample run** runs the workflow in sandbox mode against the bundled
  "can't log in" ticket. The Slack + email steps are skipped in sandbox mode, and
  with AI configured the run pauses at the agent-review form with the draft
  prefilled for editing.
- **Start recovery drill** executes `escalate` through the real BullMQ worker,
  retry classification, and terminal DLQ boundary. The retry policy correctly
  treats a controlled missing-secret probe as non-retryable before any Slack
  request, then the drill opens the recovery queue with measured runtime
  evidence.

Slack and email use `resultPolicy: "require_ok"`, so failed delivery envelopes
cannot be reported as successful workflow steps.

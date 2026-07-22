# Failed payment recovery

When a charge fails, this pack drafts a dunning outreach, gates it behind a human
approval, retries the charge through your billing system, and posts the outcome to
your collections channel.

## Flow

`webhook_received` → `ai` (schema-validated draft) → `approval` → `webhook.send` (retry charge) → `slack.post` (notify team)

Send authenticated events to `POST /triggers/webhook/ingest` with
`endpointKey: "failed-payment-recovery"`, a stable upstream `eventId`, and the
payment fields under `payload`. Retried deliveries with the same identity
converge on one Janusly run. If another active workflow uses the same endpoint
key, ingestion fails closed with HTTP 409 instead of choosing one silently.

## What you must provide

| Credential / config | Kind | Why |
| --- | --- | --- |
| `billing_webhook` | `webhook_secret` | Signs the retry-charge call to your billing system |
| `billing_slack` | `slack_webhook` | Posts the recovery outcome to your collections channel |

Installing the pack never creates these for you — wire them in the Credentials panel,
then point `retry_charge.input.url` at your real billing endpoint in the Inspector.
An Anthropic key is also required for the structured outreach draft. Missing or
invalid AI output cannot reach the approval because this workflow uses strict
template resolution.

## Try it

- **Preview sample run** runs the workflow in sandbox mode against the bundled
  "card declined" payload. Write-side steps (the retry + the Slack post) are skipped
  in sandbox mode, so no real charge or message goes out. With AI configured,
  the run pauses at the approval gate so you can inspect the generated draft.
- **Start recovery drill** lets you reproduce an unavailable credential, an
  expired credential, or an HTTP 429 on `retry_charge`. The selected drill
  records its source before opening the recovery queue, where you can inspect
  evidence and validate a proposed fix.

Both external tool steps use `resultPolicy: "require_ok"`; a provider envelope
with `ok: false` becomes a recoverable node failure rather than a false success.

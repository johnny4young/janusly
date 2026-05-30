# Failed payment recovery

When a charge fails, this pack drafts a dunning outreach, gates it behind a human
approval, retries the charge through your billing system, and posts the outcome to
your collections channel.

## Flow

`webhook` → `ai` (draft outreach) → `approval` → `webhook.send` (retry charge) → `slack.post` (notify team)

## What you must provide

| Credential / config | Kind | Why |
| --- | --- | --- |
| `billing_webhook` | `webhook_secret` | Signs the retry-charge call to your billing system |
| `billing_slack` | `slack_webhook` | Posts the recovery outcome to your collections channel |

Installing the pack never creates these for you — wire them in the Credentials panel,
then point `retry_charge.input.url` at your real billing endpoint in the Inspector.

## Try it

- **Preview sample run** runs the workflow in sandbox mode against the bundled
  "card declined" payload. Write-side steps (the retry + the Slack post) are skipped
  in sandbox mode, so no real charge or message goes out; the run pauses at the
  approval gate so you can see the human checkpoint.
- **Break a node** injects a "billing webhook secret unbound" failure on
  `retry_charge` so you can drive the recovery dialog and watch the AI propose a fix.

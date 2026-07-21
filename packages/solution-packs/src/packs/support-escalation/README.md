# Support escalation

When a support ticket comes in, this pack summarizes it with AI, lets a human agent
review and edit the reply, escalates to the support channel, and emails the customer
back.

## Flow

`webhook` → `ai` (summarize + draft) → `human_form` (agent review) → `slack.post` (escalate) → `email.send` (reply)

## What you must provide

| Credential / config | Kind | Why |
| --- | --- | --- |
| `support_slack` | `slack_webhook` | Escalates the ticket to your support channel |
| `email.from` | org config | Sender address used to reply to the customer |

Installing the pack never creates these — wire the credential in the Credentials
panel and set `email.from` in Operations → org config. `email.send` uses your
configured mailer provider, not a per-tool credential.

## Try it

- **Preview sample run** runs the workflow in sandbox mode against the bundled
  "can't log in" ticket. The Slack + email steps are skipped in sandbox mode, and
  the run pauses at the agent-review form so you can see the human checkpoint.
- **Start recovery drill** reproduces a bounded notification timeout on
  `escalate`, records the drill source, and opens the recovery queue so you can
  diagnose and validate a proposed timeout fix.

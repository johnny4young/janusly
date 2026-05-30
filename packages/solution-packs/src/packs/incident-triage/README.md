# Incident triage

When an alert fires, this pack classifies its severity with AI, opens a tracking
issue on GitHub, and pages your on-call channel on Slack.

## Flow

`webhook` → `ai` (classify severity) → `github.create_issue` → `slack.post` (page on-call)

## What you must provide

| Credential / config | Kind | Why |
| --- | --- | --- |
| `ops_github` | `github_token` | Opens the incident tracking issue in your repo |
| `ops_slack` | `slack_webhook` | Pages your on-call channel |

Installing the pack never creates these — wire them in the Credentials panel, then
set the real `owner` / `repo` on `open_issue` in the Inspector.

## Try it

- **Preview sample run** runs the workflow in sandbox mode against the bundled
  "DB pool exhausted" alert. The GitHub + Slack steps are skipped in sandbox mode,
  so no issue or page goes out.
- **Break a node** injects an "HTTP 500" failure on `page_oncall` so you can drive
  the recovery dialog and watch the AI propose a retry/backoff fix.

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
- **Start recovery drill** lets you reproduce malformed AI classification,
  GitHub response-contract drift, a temporary Slack outage, or the durable
  stale-node state left by an interrupted worker. The worker scenario crosses
  the configured age threshold and uses the real stalled-node reaper; every
  drill records its source before opening the recovery queue for diagnosis and
  sandbox validation.

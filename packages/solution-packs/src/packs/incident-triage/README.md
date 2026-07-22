# Incident triage

When an alert fires, this pack classifies its severity with AI, opens a tracking
issue on GitHub, and pages your on-call channel on Slack.

## Flow

`webhook_received` → `ai` (schema-validated severity) → `github.create_issue` → `slack.post` (page on-call)

Send authenticated events to `POST /triggers/webhook/ingest` with
`endpointKey: "incident-triage"`, a stable monitoring-system `eventId`, and
the alert fields under `payload`. Delivery retries converge on one Janusly run;
duplicate endpoint keys fail closed with HTTP 409.

## What you must provide

| Credential / config | Kind | Why |
| --- | --- | --- |
| `ops_github` | `github_token` | Opens the incident tracking issue in your repo |
| `ops_slack` | `slack_webhook` | Pages your on-call channel |

Installing the pack never creates these — wire them in the Credentials panel, then
set the real `owner` / `repo` on `open_issue` in the Inspector.
Configure the supported Anthropic provider for live classification.

## Try it

- **Preview sample run** runs the workflow in sandbox mode against the bundled
  "DB pool exhausted" alert. The GitHub + Slack steps are skipped in sandbox mode,
  so no issue or page goes out. The classifier must return the declared
  `{ severity, rationale }` JSON shape; fallback or malformed output cannot cross
  the condition guarding the issue-creation step.
- **Start recovery drill** lets you reproduce malformed AI classification,
  GitHub response-contract drift, a temporary Slack outage, or the durable
  stale-node state left by an interrupted worker. The worker scenario crosses
  the configured age threshold and uses the real stalled-node reaper; every
  drill records its source before opening the recovery queue for diagnosis and
  sandbox validation.

GitHub and Slack use `resultPolicy: "require_ok"`. A non-success provider
envelope enters the recovery path and the write-side call is not retried blindly.

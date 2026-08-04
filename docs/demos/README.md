# Janusly demos

These demos are operator-facing stories backed by templates in
`internal/httpapi/assets/templates.json`. Template labels live under
`web/src/i18n`; browser coverage lives in `web/e2e`.

## Flagship demos

| Demo | Template | Focus |
| --- | --- | --- |
| [Incident triage](incident-triage.md) | `incident-triage` | Event intake, AI summary, issue creation, notification, and recovery. |
| [Refund triage](refund-triage.md) | `refund-triage-approval` | Human approval before a signed financial effect. |
| [Failed workflow recovery](failed-workflow-recovery.md) | `failed-workflow-recovery` | Failure evidence, suggested repair, validation, and replay. |

## Supporting demos

- [Monthly report](monthly-report-pdf.md)
- [Multi-agent decision](multi-agent-decision.md)
- [MCP summary](mcp-notion-summary.md)
- [Bulk classification](bulk-classify-loop.md)

Every demo must state required credentials, input, visible run evidence, human
decisions, recovery behavior, and a measured result. Never present sample data
or estimated timing as production evidence.

Solution packs are embedded under `internal/packs/packs` and exposed through
the solution-pack API. Controlled drills execute through the normal durable
engine and are tagged as validation activity.

## Adding a demo

1. Add or update the template JSON.
2. Add English and Spanish labels in `web/src/i18n`.
3. Document setup, run sequence, evidence, and recovery here.
4. Add Go validation coverage and a browser journey in `web/e2e`.
5. Run `make test`, `make test-integration`, and the relevant E2E test.

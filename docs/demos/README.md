# Janusly demos

Canonical demos for sales calls, landing-page copy, and technical-buyer conversations. Each demo is anchored to a checked-in `WorkflowTemplate` in [`apps/api/src/templates.ts`](../../apps/api/src/templates.ts); the narrative file in this folder is the operator-facing story.

The product positioning anchors on a single sentence:

> **Janusly is an agent-native workflow orchestration and recovery platform. Every run is observable, every failure is explainable, every proposed fix is reviewable, and every production change is auditable.**

The primary business metric is **median time from a detected production failure
to a generation-bound verified recovery**. Every demo must show the real
measured clock when it completes; illustrative customer baselines are labeled
as assumptions, not product evidence.

## Flagship demos (3 — 3-5 minute sales-call material)

| Demo | Template | Audience | What it shows |
| --- | --- | --- | --- |
| [Incident triage](incident-triage.md) | `incident-triage` | SRE / on-call / operations | Webhook → AI summarize → GitHub issue → Slack notify. Observability + integration story; recovery angle when Slack rate-limits. |
| [Refund triage](refund-triage.md) | `refund-triage-approval` | Revenue ops / finance | Webhook → AI summarize → human approval → signed billing webhook → email confirmation. HITL is the headline; signed HMAC outbound is the trust story. |
| [Failed-workflow recovery](failed-workflow-recovery.md) | `failed-workflow-recovery` | Every buyer (the wedge demo) | Webhook → broken billing call → Recovery Queue → AI suggests two fixes (structural + config) → sandbox validation. Live success replay needs the operator to bind a real secret and billing sandbox URL. |

## Supporting demos (4 — technical-buyer breadth)

| Demo | Template | Audience | What it shows |
| --- | --- | --- | --- |
| [Monthly report with PDF + email](monthly-report-pdf.md) | `monthly-report-pdf` | Enterprise ops / finance | Cron → http → AI summarize → pdf.generate → email.send. Five surfaces in one flow. |
| [Multi-agent decision support](multi-agent-decision.md) | `multi-agent-decision` | AI builders / agencies | Optimist + skeptic + arbiter debate a proposal. Orchestration Zapier and n8n cannot reproduce. |
| [MCP tool integration](mcp-notion-summary.md) | `mcp-notion-summary` | AI builders / ecosystem buyers | Janusly consumes an external MCP server (Notion) as a workflow step. |
| [Bulk classify with loop](bulk-classify-loop.md) | `bulk-classify-loop` | Scale / data-volume buyers | Batch input → loop normalize → AI classify → email digest. |

## Demo conventions

Every narrative follows the same skeleton:

1. **Setup** — what credentials / inputs / environment the operator needs before running.
2. **Run sequence** — step-by-step with expected UI clicks and visible state changes.
3. **Observability story** — what the operator can see in the run timeline, audit log, usage events, budget dashboard.
4. **Human-in-the-loop story** — where the human appears, what data they see, what they decide.
5. **Recovery story** — what happens when something breaks; how the operator gets back to green.
6. **Closing metric** — the one number the demo actually measured (verified-recovery time, approvals processed, etc.) or an explicitly labeled estimate.
7. **3-5 minute talk track** — a tight script for live demos and screen recordings.

## Templates vs solution packs

The narrative demos above are anchored to `WorkflowTemplate` entries: immutable
starter DAGs served by `GET /templates` and copied into the editor.

Solution packs live separately in [`packages/solution-packs/`](../../packages/solution-packs/).
They are installable ICP-shaped bundles with workflow JSON, required credential
hints, sample payloads, failure fixtures, and pack-local READMEs. The API exposes
them through `GET /solution-packs`, `POST /workflows/import-pack`,
`POST /solution-packs/:id/sample-run`, and
`POST /solution-packs/:id/inject-failure`. The current pack ids are
`failed-payment-recovery`, `incident-triage`, and `support-escalation`.
Fixtures declare whether they use a direct deterministic failure or the real
stalled-node reaper; the incident-triage worker-interruption drill uses the
latter and reports measured reaper evidence.

## How these docs feed downstream work

- **Landing-page copy** (`docs/marketing/landing-page.md`) — hero subcopy, problem statement, use-case cards, and security/control proof points are derived from the per-demo "story" sections.
- **Sales calls** — the talk tracks here are the literal scripts.
- **Recording scripts** ([`docs/marketing/recording-scripts/`](../marketing/recording-scripts/)) — second-by-second timed beat sheets for the three flagship demos, with exact button labels, copy-pasteable setup commands, sample payloads, and failure-injection / recovery-moment sequences. Use these when filming a sales recording or onboarding a private-beta design partner.
- **Private-beta recovery-time experiment** — design partners walk through the three flagship demos before measuring their baseline; the post-flow surveys ask which demo moved them most.

## Adding a new demo

1. Add or pick a `WorkflowTemplate` in [`apps/api/src/templates.ts`](../../apps/api/src/templates.ts).
2. Add i18n keys for `templates.<id>.name` and `templates.<id>.description` in [`apps/web/src/i18n/locales/en/common.json`](../../apps/web/src/i18n/locales/en/common.json) and the Spanish sibling.
3. Add an entry to [`evals/generate-workflow.jsonl`](../../evals/generate-workflow.jsonl) when AI generation should cover the demo. Use `expect.fallbackTemplate: "<id>"` only when the deterministic no-LLM fallback should return that exact template.
4. Add a section to [`docs/templates.md`](../templates.md) describing the template (technical reference).
5. Add a narrative file here (operator-facing demo story) using the seven-section skeleton above.
6. Extend [`apps/web/e2e/demo-templates.spec.ts`](../../apps/web/e2e/demo-templates.spec.ts) to validate the new demo end-to-end.
7. Link the new demo from the table in this README.

For a new solution pack, add a folder under
[`packages/solution-packs/src/packs/`](../../packages/solution-packs/src/packs/)
with `pack.json` + `README.md`, register it in the package barrel, add EN/ES
`packs.*` labels, and extend `packages/solution-packs/src/solution-packs.test.ts`
plus `apps/web/e2e/solution-packs.spec.ts` when the UI flow changes.

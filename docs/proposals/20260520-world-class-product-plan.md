# Janusly World-Class Product Plan - May 20, 2026

> Status: strategic planning input, not the active ticket source.
> Canonical ticket status remains in `docs/ROADMAP.md` section 3b.

This document answers one question: what must Janusly become to reach
world-class quality in its market?

## Executive Decision

Janusly should not try to become the largest automation builder, the easiest
no-code canvas, or a generic agent platform. The world-class goal is narrower
and stronger:

> Janusly should become the recovery and control plane for AI workflows that
> matter in production.

The product should win when a team says:

- "Our AI workflow works in demos but breaks in production."
- "We need to know why this automation failed."
- "Compliance asked who approved this AI action."
- "We need to replay the fix before touching real systems."
- "We want AI to improve the workflow, but not mutate production silently."

The market objective is not "every workflow team." The first market is
technical operators at B2B startups, engineering/support teams, and AI
builders/agencies who already feel workflow failures as operational pain. The
buyer may be a COO, VP Engineering, or agency founder, but the daily user must
be someone who cares about evidence, recovery, audit, and MTTR.

The north-star metric stays:

> Median Mean Time To Recovery for failed AI workflows.

The world-class product bar is:

> When a workflow fails at 3am, Janusly detects it, groups it with similar
> failures, explains the likely root cause, proposes safe fixes, validates the
> preferred fix in replay/sandbox mode, captures approval, applies or replays
> without mutating external state unexpectedly, records the evidence, learns
> from the outcome, and reports the value in MTTR terms.

## Market Calibration

Competitors have moved toward "AI agents inside automation." That validates the
category, but it also means Janusly cannot rely on "AI workflow builder" as the
whole story.

| Market signal | What it means for Janusly |
| --- | --- |
| Zapier Agents lets users create AI agents on top of Zapier's thousands of apps, with actions, knowledge sources, issue assistance, and usage limits. See [Zapier Agents](https://help.zapier.com/hc/en-us/articles/24393442652557-Build-an-agent-in-Zapier-Agents). | Zapier owns breadth and SMB no-code reach. Janusly must win after the workflow breaks, not before the first connector is added. |
| n8n positions AI agents around source availability, 500+ integrations, code flexibility, memory, RAG, human-in-the-loop, monitoring, and evals. See [n8n AI agents](https://n8n.io/ai-agents/). | Technical builders now expect AI nodes, memory, HITL, and evals. Janusly's recovery loop must be visibly deeper than a generic error-workflow pattern. |
| Make AI Agents emphasizes transparent agents across 3,000+ apps. See [Make AI Agents](https://www.make.com/en/ai-agents). | Visual automation tools are absorbing agent language. Janusly should not compete on canvas polish alone. |
| Workato's Agentic and MCP documentation emphasizes low/no-code AI tools, MCP servers, user traceability, rate limits, and trusted registry controls. See [Workato Agentic](https://docs.workato.com/agentic/agentic.html). | Enterprise buyers will expect governance around agent actions. Janusly's audit, RBAC, SCIM, and MCP consent story must be easy to prove. |
| Pipedream advertises 3,000+ APIs, 10,000+ tools, and MCP for agents. See [Pipedream](https://pipedream.com/). | Raw integration/tool count is a losing race. Janusly should make external tools safer to operate, not try to mirror the catalog. |
| Relay leads with predictable AI workflows. See [Relay](https://www.relay.app/how-it-works). | "Predictable AI workflows" is now table stakes copy. Janusly needs operational evidence: replay, rollback, audit, MTTR. |
| LangGraph highlights durable execution, human-in-the-loop, memory, streaming, and observability for agents. See [LangGraph](https://docs.langchain.com/oss/python/langgraph/overview). | Agent builders expect durable state and memory. Janusly must decide where it is a product above frameworks, not just a runtime. |
| LangSmith emphasizes traces, failure debugging, evals, human feedback, online/offline evaluation, deployment, and rollback. See [LangSmith](https://www.langchain.com/langsmith-platform). | AI quality and evals are becoming buying criteria. Janusly needs a built-in evaluation loop tied to workflow recovery, not just logs. |
| Temporal sells durable execution, replay, retries, human input, long-running workflows, and visibility. See [Temporal](https://temporal.io/). | Durable execution is a mature expectation. Janusly must make the operator/recovery layer the differentiator above runtime reliability. |

Conclusion: the category is converging on agentic automation. Janusly's durable
position is "AI workflows you can operate after they fail."

## Current Advantage

Janusly already has unusually strong foundations for the wedge:

- Postgres-backed DAG runtime with durable run state.
- Structured `run_events`, DLQ, failure signatures, and recovery metrics.
- AI explain-run, workflow review, patch suggestion, and deterministic fallback.
- Sandbox validation before recovery save/replay.
- Version history and rollback.
- Human approval and human form primitives.
- Audit logs, RBAC, custom roles, WorkOS SSO, SCIM, and org-scoped auth.
- MCP server and MCP client with consent, audit, dry-run, rate limits, and tool
  exposure controls.
- Usage events and AI budget governance.
- Product narrative centered on MTTR.

The main risk is not "Janusly lacks features." The main risk is diffused focus:
too many adjacent platform ideas can blur the recovery wedge. The plan below
keeps the wedge primary.

## World-Class Definition

Janusly reaches world-class quality when it is excellent across five product
pillars.

### 1. Recovery OS

World-class state:

- Recovery Center is the default daily workspace for operators.
- Failures are grouped, deduplicated, assigned, prioritized, and tracked to
  resolution.
- Every recovery item has owner, severity, SLA, related runs, root-cause
  summary, proposed fixes, validation status, approval trail, and rollback path.
- Operators can open a targeted Replay Lab fork from any failed node, edit
  bounded context, and compare base vs candidate.
- Auto-healing is supervised by default and auto-apply is a gated mode, not the
  default promise.

Missing or incomplete:

- Alerting and escalation policies.
- Recovery ownership and incident-style workflow.
- Runbook / decision checklist per failure class.
- First-class incident handoff to Slack, Linear, GitHub, and email.
- Stronger workflow SLO and health policy layer.

### 2. AI Quality Loop

World-class state:

- Prompts are versioned, evaluable, and reusable.
- Every prompt/model change can be tested against production-derived examples.
- Accepted and rejected recovery suggestions become labeled data.
- Memory is tenant-scoped, opt-in, scrubbed, retained/deleted/exported by policy,
  and framed as data rather than instructions.
- Model routing improves cost/quality without breaking fallback behavior.

Missing or incomplete:

- PromptOps registry is pending.
- Memory privacy policy and vector substrate are pending.
- Eval datasets from real runs are not first-class.
- Prompt/model experiment harness is not shipped.
- Online evals and human annotation queues are not built.

### 3. Safe Action Layer

World-class state:

- Janusly can act across enough real systems to prove the recovery wedge, but it
  never chases raw catalog count.
- The safest path to broad integrations is MCP with governance, not custom
  connectors for every SaaS app.
- Write-side actions have typed input, dry-run behavior, consent, rate limits,
  audit, and redaction.
- Credential health and tool health are visible before a run fails.

Missing or incomplete:

- Stdio MCP hardening is pending.
- External MCP discovery is present, but "trusted tool packs" are not packaged.
- Credential rotation / expiry / missing secret health is not a product surface.
- Demo-ready integration packs need packaging around Slack, GitHub, Linear,
  email, signed webhooks, and Notion/MCP.

### 4. Enterprise Trust

World-class state:

- A buyer can hand the security team one evidence packet: auth model, tenant
  boundaries, audit events, retention defaults, recovery replay safety, data
  use policy, backup/restore posture, and incident response posture.
- Enterprise admins can set retention, export audit evidence, prove who approved
  actions, and manage identities through SSO/SCIM.
- Managed cloud has an operations story: backups, migrations, worker scaling,
  queue health, deployment rollback, and support escalation.

Missing or incomplete:

- Audit/evidence export packet is not a first-class artifact.
- Retention/archive policy is still broader roadmap work.
- Managed-cloud ops runbook and DR posture are not packaged.
- Compliance packet is scattered across docs instead of one buyer-ready page.

### 5. Distribution and Adoption

World-class state:

- A technical operator can reach "first recovered run" in under 60 minutes.
- SDKs make Janusly embeddable in customer apps.
- Solution packs turn the three ICP wedges into concrete workflows:
  payment/refund recovery, incident triage, and support escalation.
- Public docs make the product self-serve for technical teams without hiding the
  current Anthropic-only AI posture.

Missing or incomplete:

- TypeScript and Python SDKs are pending.
- Guided onboarding is not optimized around "first recovered run."
- Solution packs exist as demos, but not as installable, versioned packages.
- Public API key management and outbound webhook callbacks need a productized
  surface.

## Market Objective

### Beachhead

The best first market is:

> Technical operators at B2B SaaS and AI-service companies running customer-
> facing or ops-critical AI workflows where failure has visible cost.

This blends the existing three ICPs without weakening focus:

- B2B startups with ops workflows provide the clearest business pain.
- Engineering/support teams provide the strongest technical buyer.
- AI builders/agencies provide the strongest distribution leverage.

For the first 90 days, design partners can span all three. For sales focus, the
message should lead with the buyer trigger, not the segment label:

1. "Our automation broke and we could not explain it."
2. "Our AI workflow demo works, but production is unreliable."
3. "We need auditability before AI can touch real work."

### Segment Order

| Order | Segment | Why now | Main demo |
| --- | --- | --- | --- |
| 1 | Engineering/support teams | They understand runtime, logs, failure, audit, and MTTR fastest. They can evaluate Janusly without no-code expectations. | Incident triage + failed workflow recovery |
| 2 | AI builders/agencies | They already feel the cost of rebuilding recovery glue per client and can become repeat users across client orgs. | Multi-agent decision + MCP + failed workflow recovery |
| 3 | B2B startups with ops workflows | Highest business value, but needs smoother onboarding and less technical UX to convert consistently. | Refund triage + failed workflow recovery |

This does not change the ICP docs. It clarifies execution order.

## Strategic Feature Plan

### Phase 0 - Prove the Wedge

Goal: prove that the market cares enough about recovery/MTTR to pay.

Must ship / run:

- Finish ENG-093 private-beta MTTR experiment.
- Keep ENG-110 marketing parity moving, but do not let localization outrank
  product proof.
- Run one design partner per ICP if possible.
- Publish an internal verdict: keep Recovery Center as product home, narrow ICP,
  or pivot.

Exit criteria:

- 2 of 3 design partners show measurable MTTR improvement.
- 2 of 3 can name a willingness-to-pay band.
- First recovered run takes under 60 minutes for 2 of 3 partners.

### Phase 1 - Make Recovery Undeniable

Goal: every demo and trial should show the recovery loop in less than five
minutes.

Already covered by ENG-111..ENG-121:

- PromptOps.
- Memory policy and vector memory.
- Memory-assisted recovery suggestions.
- Supervised auto-healing queue.
- Targeted Replay Lab forks.
- MTTR/value dashboard.
- Rate-limit degradation visibility.

Additional missing features:

- Recovery alerting and escalation.
- Recovery ownership, severity, SLA, and runbook states.
- Incident handoff to Slack/Linear/GitHub/email.
- Workflow SLO policy engine.
- Credential/tool health preflight.

### Phase 2 - Make AI Improve Safely

Goal: every AI improvement becomes measurable before it touches production.

Must ship:

- Eval dataset builder from real runs and recovery feedback.
- Prompt/model experiment harness.
- Offline comparison of prompt versions and model choices.
- Online eval annotations for recovered failures.
- Recommendation-only promotion first; no automatic prompt/model promotion by
  default.

Design rule:

> AI may recommend. Janusly validates. The operator approves. Only then does
> production change.

### Phase 3 - Make Adoption Fast

Goal: a technical operator can install or sign up, run a solution pack, break it
intentionally, recover it, and understand the value in under 60 minutes.

Must ship:

- Guided onboarding around "first recovered run."
- Solution packs for the three ICPs.
- SDK examples that start a run, wait, handle human form resume, and fetch the
  recovery report.
- Public API keys and outbound webhook callbacks.
- Clear quickstart paths for self-host and managed cloud.

### Phase 4 - Make Enterprise Procurement Easy

Goal: a buyer can answer security, compliance, and operations questions without
asking engineering to assemble ad hoc evidence.

Must ship:

- Audit evidence export.
- Retention/archive settings.
- Compliance and security packet.
- Managed-cloud operations runbook.
- Backup/restore and disaster-recovery procedure.
- Enterprise onboarding checklist.

## Candidate Backlog

These are candidate roadmap rows for after the active ENG-111..ENG-121 queue is
accepted or reprioritized. Promote into `docs/ROADMAP.md` as `ENG-122+` only
when the team decides to make this plan executable.

| Candidate ID | Title | Priority | Depends | Acceptance criteria |
| --- | --- | --- | --- | --- |
| ENG-122 | Add recovery alerting policies | P1 | Recovery Center | Operators can define per-workflow or org-level alert rules for DLQ entry created, failure cluster threshold, budget block, degraded limiter, and workflow SLO breach; delivery channels include email, Slack/webhook where configured; alerts dedupe by failure signature, support cooldown/snooze, and write audit/events. Tests cover dedupe, cooldown, tenant scope, channel failure, and no secret leakage. |
| ENG-123 | Add recovery ownership workflow | P1 | ENG-122 | Recovery items have owner, severity, SLA target, status, comments, and resolution reason; UI supports assign, acknowledge, escalate, resolve, reopen; every transition is audited; filters support owner/severity/status/SLA. Tests cover role gates, audit rows, SLA clock, cross-org isolation, and EN/ES copy. |
| ENG-124 | Add incident handoff integrations | P1 | ENG-122 | From a recovery item, an operator can create or update a Slack thread, Linear issue, GitHub issue, or signed webhook handoff with idempotency keyed by recovery item; handoff payload includes root cause, affected workflow/run, suggested fix, validation status, owner, and link back. Tests cover idempotency, provider failures, redaction, dry-run/write-side gating, and audit metadata. |
| ENG-125 | Add workflow SLO policy engine | P1 | ENG-120 | Workflows can define reliability SLOs for failure rate, MTTR, p95 duration, budget blocks, and stuck waiting nodes; health status is computed from bounded windows and can trigger ENG-122 alerts. Tests cover window bounds, null data, threshold changes, alert triggering, and index-friendly query shape. |
| ENG-126 | Add credential health preflight | P1 | MCP/credentials | Janusly surfaces missing secret refs, expired/rotated credentials where detectable, invalid webhook signatures, disabled MCP connections, and tool descriptor drift before runs fail; health findings appear in workflow readiness and Operations. Tests cover missing env refs without leaking env names, disabled connections, descriptor drift, and tenant-scoped visibility. |
| ENG-127 | Build eval datasets from recoveries | P1 | ENG-114, ENG-116 | Accepted/rejected recovery suggestions and run traces can be converted into scrubbed, tenant-scoped eval examples with explicit consent; examples store input context, expected outcome, approval label, and retention metadata. Tests cover opt-in enforcement, scrubbing, deletion/export, prompt-injection framing, and cross-org isolation. |
| ENG-128 | Add prompt/model experiment harness | P1 | ENG-111, ENG-127 | Operators can compare prompt versions and model choices against an eval dataset; results show pass rate, cost, latency, fallback rate, and regression examples; promotion is recommendation-only by default and audited if accepted. Tests cover deterministic fixture evals, unknown model fallback, cost null handling, no production mutation, and audit rows. |
| ENG-129 | Add solution packs | P1 | ENG-112 | Ship installable, versioned solution packs for failed payment recovery, incident triage, and support escalation; each pack includes workflow JSON, required credentials, setup wizard, sample payloads, failure injection, expected recovery path, and docs. Tests cover pack install/fork, missing credential checks, sample run, failure injection, and i18n. |
| ENG-130 | Add first recovered run onboarding | P1 | ENG-129 | New users are guided from setup to one successful run and one intentionally failed/recovered run in under 60 minutes; UI tracks progress without hiding advanced surfaces; self-host and cloud paths diverge only where infrastructure differs. Tests cover progress state, restart/resume, empty org, missing AI key fallback, and EN/ES copy. |
| ENG-131 | Add public API keys and webhooks | P1 | ENG-112 | Admins can create/revoke scoped API keys and configure outbound webhooks for run completed, run failed, recovery item created, recovery resolved, and budget blocked; signatures are HMAC with timestamp tolerance and replay guidance. Tests cover key scope, revocation, signature verification examples, retry/backoff, idempotency, and audit rows. |
| ENG-132 | Add audit evidence export | P1 | ENG-123 | Operators can export a recovery evidence packet containing run timeline, DLQ row, failure signature, AI explanation mode, selected patch diff, sandbox validation result, approvals, audit rows, and rollback link. Exports redact secrets and can be attached to compliance tickets. Tests cover redaction, tenant scope, large timeline pagination, and stable JSON/PDF output. |
| ENG-133 | Add retention and archive policy | P1 | ENG-114 | Org admins can configure retention for run events, audit logs, usage events, recovery feedback, and memory entries within safe bounds; archive/delete jobs are idempotent and preserve required audit minimums. Tests cover catalog validation, retention job bounds, legal-hold style bypass if included, export-before-delete, and cross-org isolation. |
| ENG-134 | Add managed-cloud ops runbook | P2 | Deployment decision | Document and validate the managed-cloud posture: migrations, backups, restore drill, worker scaling, queue health, Redis/Postgres failure behavior, deployment rollback, incident response, and support escalation. Validation includes at least one restore drill script or checklist and links from pricing/enterprise docs. |
| ENG-135 | Add compliance packet | P2 | ENG-132, ENG-133 | Create a buyer-ready security/compliance packet covering auth, tenant isolation, audit actions, retention, data use, AI provider posture, MCP consent, backup/restore, incident response, and subprocess sandboxing. Every claim links to code docs or roadmap status and marks roadmap items honestly. |
| ENG-136 | Add verified recipe store | P2 | ENG-129 | Solution packs graduate into a versioned recipe store with install/fork, changelog, compatibility checks, owner, risk label, and recovery path. Tests cover version pinning, upgrade preview, downgrade/revert, credential requirements, and tenant isolation. |

## Features To Avoid For Now

Do not spend near-term roadmap on:

- Broad connector-count race.
- Generic RPA or desktop automation.
- Fully autonomous production mutation as default behavior.
- Generic cross-database `db.query.*` without a concrete customer schema and
  schema-discovery story.
- OpenAI-first runtime posture before cross-provider verification reopens.
- Public competitor attack pages before the product has private-beta proof.
- Marketplace breadth before the three solution packs work end-to-end.

## Measurement Scorecard

| Metric | Target | Why it matters |
| --- | --- | --- |
| Time to first recovered run | < 60 minutes for a new technical operator | Proves adoption, not just product depth. |
| Private-beta MTTR delta | 10x median improvement, or a documented reason why not | Proves the wedge. |
| Recovery suggestion validation pass rate | > 70% for high-confidence suggestions in beta workflows | Proves AI suggestions are operationally useful. |
| Production mutation audit coverage | 100% | Required for trust. |
| Sandbox-before-save coverage | 100% for AI-suggested recovery patches | Required for "safe evolution." |
| Cross-org isolation incidents | 0 | Non-negotiable. |
| Alert dedupe accuracy | No duplicate alert storm for one failure signature inside cooldown | Required for operator trust. |
| Evidence export completeness | Packet includes timeline, patch, validation, approval, audit, rollback link | Required for compliance buyers. |
| SDK time to start/poll/report | < 15 minutes from docs for a technical user | Required for distribution. |
| Solution pack setup | < 20 minutes to install and run sample payload | Required for repeatable sales demos. |

## Recommended Execution Order

1. Finish private-beta proof and do not blur the wedge.
2. Ship ENG-111..ENG-121 that strengthen recovery, memory, PromptOps, SDKs, and
   value measurement.
3. Promote ENG-122, ENG-123, ENG-124, ENG-125, and ENG-126 first from this plan.
   Those turn Recovery Center into an operational cockpit.
4. Promote ENG-127 and ENG-128 once PromptOps and memory policy are in place.
   Those make AI improvement measurable.
5. Promote ENG-129, ENG-130, and ENG-131 to reduce adoption friction.
6. Promote ENG-132..ENG-135 when enterprise deals start asking for evidence
   packets, retention, or managed-cloud proof.

If only one sentence survives this plan, keep this:

> Janusly reaches world-class status by becoming the product teams open when an
> AI workflow fails, not the product they open only when they first draw the
> workflow.

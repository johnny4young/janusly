# Janusly ICP and sales motion

The operational layer for "who do we sell to, and how." This document is the sales-team's open tab during a call: scan a segment card on the left monitor while you're in the discovery on the right.

This is **not** the strategic positioning — that lives in [`docs/PLAN.md` §16.0](../PLAN.md). And it is **not** the brand voice — that lives in [`docs/marketing/narrative.md`](narrative.md). This document is what you say after the buyer says "tell me about Janusly" and you need to know which demo to load, which pain to lead with, which objection to anticipate, and what success looks like 90 days later.

The three canonical segments below match [`docs/PLAN.md` §16.3](../PLAN.md) verbatim. When you see a new segment name in a conference talk or a slide, it is wrong — bring it back to one of these three.

---

## Segment 1 — B2B startups with ops workflows

> Automate ops workflows without losing control when AI is involved.

The fastest-moving segment, with the loudest pain. Series A–C SaaS companies running 20–200 employees, where ops, finance, and support work has outgrown spreadsheets but no one has time to build a real workflow platform from scratch.

### Pain points (the buyer's own words)

- "Billing exceptions wake me up. We process refunds in three places — Stripe, our admin tool, customer support — and they all disagree about which one is the source of truth."
- "Every refund is the same five clicks. My ops lead spends 90 minutes a day on it."
- "When something breaks at 3am, the on-call engineer pings the ops lead, who pings the platform team, who has to figure out which Slack thread had the last working state. Half an hour of toil before anyone touches code."
- "We tried Zapier for the simple stuff. It works until a step fails — and then we have no idea what failed, what to retry, or what changed."
- "We need an audit trail of who approved what, because finance asks at quarter-end and right now we screenshot Slack."

### Buyer and user

- **Buyer (signs the PO):** Founder / COO / VP Operations. Owns the budget for ops tooling and feels the pain personally.
- **User (uses the product daily):** Ops lead, finance ops associate, customer-support team lead. They build / approve / monitor workflows; they file the audit reports at quarter-end.

The buyer rarely uses the product after the first month. The user is the retention signal — if the ops lead opens Janusly daily, the contract renews.

### Demo angle

- **Lead with:** [`refund-triage.md`](recording-scripts/refund-triage.md) — the human-in-the-loop story (webhook → AI summary → human approval → signed billing webhook → email) is the closest match to what they're doing manually today.
- **Follow up with (if technical):** [`failed-workflow-recovery.md`](recording-scripts/failed-workflow-recovery.md) — the wedge demo. "And here's what happens when the billing call fails." Two recovery paths, sandbox validation, replay.
- **Skip:** the AI-builder demos (multi-agent, MCP) — irrelevant to this segment's pain.

### Objection handling

- **"I already have Zapier."** "Zapier is great when your question is 'how do I connect SaaS apps that already work?' We're the layer you reach for when one of those apps fails — Zapier doesn't help you when Stripe returns a 401 or your billing API rotates a credential. Try our recovery demo for two minutes; you'll see the difference immediately."
- **"AI workflows are too risky for finance/billing work."** "We agree — which is why the human approval gate is a first-class node, and every patch goes through sandbox validation before it touches production. The AI proposes; your ops lead decides. We don't ship 'autonomous' anything for billing."
- **"Can't my engineers build this in a weekend?"** "They can build the happy path in a weekend. The recovery layer — DLQ, structured failure explanations, sandbox replay, audit log, version rollback — is the part that takes six months and three iterations. We've already done that work."

### First outreach copy

**Cold email (3 paragraphs):**

> Subject: 90 minutes/day of refund toil?
>
> Hey [name] — saw you're running ops at [company]. Quick hypothesis: if your team is processing refunds/billing exceptions/escalations manually in three different tools, you're probably losing about 90 minutes/day of an ops lead's time. And when something breaks at 3am, you're losing half an hour of an engineer too.
>
> Janusly is the recovery-first AI workflow platform we built for this exact pain — your ops lead approves the call in one click, the billing webhook fires with an HMAC signature, and when it fails (because eventually it will), the AI shows you what broke and offers a fix you can validate in a sandbox before retrying.
>
> 4-minute recording of the refund-triage flow: [link to refund-triage recording]. Worth 15 minutes to walk through next week?

**LinkedIn DM (2 sentences):**

> [name] — saw you're running ops at [company]. Built a recovery-first AI workflow platform for refund / billing / escalation work; the demo is 4 minutes and it'll either resonate immediately or not at all. Happy to send the link?

### Success metric

- **Master metric:** Mean Time To Recovery for failed billing/refund/escalation runs. Baseline ~30 min (manual triage); target <3 min (Recovery Center loop).
- **Leading indicator:** Approvals processed per ops-lead hour. Baseline ~4/hour (manual click-through); target 30+/hour (one-click approve from Janusly).
- **Retention signal:** Ops lead opens Janusly ≥3 days/week in month 2.

---

## Segment 2 — Engineering/support teams

> Turn incidents and escalations into explainable workflows with recovery built in.

Engineering managers, SREs, and platform teams at companies where the volume of customer-bug-reports and infrastructure-alerts has outgrown manual triage. Often the same company as Segment 1, but the buyer is a different person — the engineering manager rather than the COO.

### Pain points (the buyer's own words)

- "Every incident is the same triage: read the alert, find the affected service, file the GitHub issue, ping the on-call, paste the link in the right Slack channel. Fifteen minutes of toil per incident, and we have eight a week."
- "Our on-call rotation is burned out. Half their pages are paperwork that could be automated, but Zapier-style tools don't handle our auth / our infra / our context."
- "When a customer-support escalation comes in, it bounces through three engineers before someone owns it. By then the customer has churned."
- "We tried to build internal tooling. The first version worked; the moment a step started failing intermittently we discovered we had no recovery story and no audit log."
- "We don't trust AI to act in production yet. We trust it to summarize, classify, draft — but the human still presses the button."

### Buyer and user

- **Buyer (signs the PO):** VP Engineering / Engineering Manager / Director of Platform. Owns the on-call rotation health, the SRE budget, and the platform-tooling decisions.
- **User (uses the product daily):** SRE, on-call engineer, platform-team developer, customer-support engineering lead. They wire workflows, they approve runs in the recovery dialog, they read the timeline at 3am.

The user is more technical here than in Segment 1 — they'll inspect the workflow DAG, ask about the runtime, want to see the audit log schema. Bring the engineering-manager talk track.

### Demo angle

- **Lead with:** [`incident-triage.md`](recording-scripts/incident-triage.md) — webhook in, AI summarize, GitHub issue, Slack notify. The structure mirrors their internal tooling but the AI step + the audit trail are net new.
- **Follow up with:** [`failed-workflow-recovery.md`](recording-scripts/failed-workflow-recovery.md) — the wedge demo. Critical for this segment because they have a high "we tried to build it" baseline; the Recovery Center loop is the part their internal tooling didn't have.
- **Skip:** Multi-agent / MCP demos unless they specifically mention "we're building agents." Refund-triage is also lower-priority — they're not the ones approving refunds.

### Objection handling

- **"We already have a runbook / a Lambda / a Slack bot for this."** "Then you have the happy path. Show me what happens when the Slack webhook rate-limits, or when the GitHub credential rotates — does your runbook explain what broke, or do you read the stack trace? We're the layer that closes that gap. The flow you've already built keeps working; Janusly wraps it with observability + recovery."
- **"How is this different from Temporal / Airflow / Inngest?"** "Those are durable-workflow runtimes — solid foundation. We are too, but the differentiator is the operator surface: AI-explained failures, AI-suggested patches with confidence scores, sandbox validation before save, version rollback in one click. Same runtime layer, plus the recovery layer on top."
- **"We're not ready to put AI in the on-call loop."** "Neither are we. The AI proposes the fix; the human reviews the diff, validates in a sandbox, and clicks apply. There is no autonomous-AI action against production in our default. If you want autonomous later, the same primitives support it — but the gate is yours to lift."

### First outreach copy

**Cold email (3 paragraphs):**

> Subject: Eight incidents a week — how many are paperwork?
>
> Hey [name] — engineering managers I've talked to recently say something like: "half my on-call's pages are paperwork I could automate, but I don't trust off-the-shelf tools with our auth or our context." Is that a fair read for [company]?
>
> Janusly is the AI workflow platform we built for engineering teams that have outgrown Zapier but don't want to keep building internal tooling for incident triage / escalation routing / status-page automation. The differentiator is the recovery layer — when a step fails, the AI explains what broke and proposes a fix you can validate in a sandbox before saving. Audit log per action, version rollback in one click, multi-tenant scope on every query.
>
> 4-minute recording of the incident-triage flow: [link]. Worth 15 minutes next week if it resonates?

**LinkedIn DM (2 sentences):**

> [name] — engineering team at [company]. Built an AI workflow platform with a recovery-first runtime; 4-min recording walks through the incident-triage flow. If you've already tried building something like this in-house, the recovery layer is probably the part you didn't get to.

### Success metric

- **Master metric:** Mean Time To Recovery for failed workflow runs. Baseline ~45 min (page on-call, read trace, redeploy, retry); target <3 min (Recovery Center loop).
- **Leading indicator:** Incidents auto-triaged per week (without paging on-call). Baseline 0 (everything pages); target 5+/week.
- **Retention signal:** SRE opens the Recovery Center ≥1 time per on-call shift in month 2.

---

## Segment 3 — AI builders/agencies

> Ship client AI workflows with a runtime, visual ops, MCP, and recovery.

Founders and tech leads at AI agencies, AI-product startups, and consulting shops that ship custom AI workflows for clients. They write the agent code; they need the runtime, the audit log, and the recovery story to feel comfortable putting their client's billing flow on top of it.

### Pain points (the buyer's own words)

- "I built a great agent demo for the client. Now they want to put it in production and I realized I have nothing — no runtime, no audit log, no way to roll back when the model misbehaves."
- "Every client wants 'AI but governable.' I keep writing the same recovery glue: retries, DLQ, replay, version history. It's six weeks of work per client and we resell it badly."
- "MCP is going to be everywhere in 12 months. I want my agency's workflows to consume MCP servers without me having to plumb each one."
- "I need to show the client a non-engineer-readable run timeline. I'm tired of pasting logs into Notion."
- "When the client's lawyer asks 'who approved this AI action?', I want to point them at an audit log, not say 'um, let me check Slack.'"

### Buyer and user

- **Buyer (signs the PO):** Agency founder / tech lead / VP delivery. Wins on speed-to-client-go-live; their margin shrinks every week of glue code they re-write per project.
- **User (uses the product daily):** Senior AI engineer / solution architect / "the person who shipped the demo." They prototype workflows, they configure MCP connections, they set up the audit-log dashboard for the client.

The user is the most technical of the three segments. They'll ask about the multi-agent primitive, the LLM provider abstraction, MCP write-consent, and the structural-patch envelope shape. Bring the technical-AI-buyer talk track.

### Demo angle

- **Lead with:** [`multi-agent-decision`](../demos/multi-agent-decision.md) — three-agent debate primitive, observable per-agent timeline. The "orchestration Zapier and n8n cannot reproduce" framing lands hard here. Narrative doc only; no recording script yet (only the 3 flagships have recording scripts) — walk it live or send the narrative doc as homework.
- **Follow up with:** [`mcp-notion-summary`](../demos/mcp-notion-summary.md) — the MCP client story. Wire a connection once, every workflow gets it. Differentiator vs. building MCP plumbing per-client. Then [`failed-workflow-recovery.md`](recording-scripts/failed-workflow-recovery.md) for the recovery loop (this one IS a recording script — playable end-to-end).
- **Skip:** Refund-triage and incident-triage are too generic for this segment — they want to see the AI-native primitives, not the SaaS-glue use cases.

### Objection handling

- **"I already use LangChain / LangGraph / a custom runtime."** "Those are libraries — solid for prototyping. We're the production runtime that wraps them: persistent DAG state, structured audit, AI-suggested recovery, version rollback. You keep your agent code; we give you the surface to operate it after handoff to the client."
- **"My client's compliance team won't approve a third-party platform handling their AI runs."** "Multi-tenant scope is enforced on every query, audit log is per-org row-per-action, secret material lives in env (we store only the env-var name, never the secret value), SSO/SCIM via WorkOS. If their compliance team asks specific questions, we have answers."
- **"Can I white-label / embed Janusly in our agency product?"** "Not in v1 — we're focused on direct sales. But we expose every primitive via API and MCP; you can build agency-side dashboards that read our run timeline. White-label is a future conversation."

### First outreach copy

**Cold email (3 paragraphs):**

> Subject: Six weeks of recovery glue per client?
>
> Hey [name] — AI agency leads I've talked to recently keep saying the same thing: "my engineers ship a great demo, then we spend six weeks per client writing retry / DLQ / audit / rollback glue because the prototype runtime doesn't survive production." Is that a familiar shape for [agency]?
>
> Janusly is the production AI workflow runtime we built so that's not your problem anymore. Visual DAG ops, persistent run state, structured audit log, AI-suggested recovery patches with sandbox validation, MCP client + server, multi-agent primitive. Your engineers write the agent code; we own the surface your client's compliance team will ask about.
>
> Short walkthrough of the multi-agent decision flow: [link to multi-agent narrative]. If recovery glue is the bottleneck on your delivery margin, this is worth 15 minutes.

**LinkedIn DM (2 sentences):**

> [name] — AI agency lead at [agency]. Built the production runtime for the recovery / audit / rollback glue you're probably re-writing per client. Short multi-agent walkthrough; if it doesn't resonate the first minute, you can close it.

### Success metric

- **Master metric:** Time-to-client-go-live with audit + recovery. Baseline ~6 weeks (custom glue per project); target <1 week (drop Janusly in, configure org, ship).
- **Leading indicator:** Number of client orgs running on Janusly with zero glue-code in month 2.
- **Retention signal:** Agency uses Janusly for ≥2 client projects within 90 days of signing.

---

## Sales motion overview

How a Janusly deal moves from first touch to closed contract. Numbers below are **v1 hypotheses to be validated by ENG-093** (the private-beta MTTR experiment with 3 design partners) — adjust after real data lands.

### Stage 1 — Cold outreach (day 0)

Cold email or LinkedIn DM, per the segment-specific copy above. Open with a pain the segment recognises in their own language. Close with the relevant demo asset (4-minute recording for flagship demos, narrative pre-read for supporting demos) as the only CTA. Do not pitch "let's chat" without a concrete asset attached.

**Hypothesis reply rate:** 5–10% for warm cold (segment-fit + named individual), 1–3% for spray-and-pray. Validate via ENG-093.

### Stage 2 — Discovery call (15 min)

If the prospect replies, book a 15-minute discovery. Goals:

1. Confirm segment fit (the persona-to-segment table at the bottom of this doc is the in-call cheat sheet).
2. Identify the specific pain — billing exceptions / incident triage / agency client work / something else?
3. Pick the demo to lead with based on the answer (refund-triage / incident-triage / multi-agent + MCP).
4. Book the demo for 4–7 days later (gives them time to invite their technical evaluator).

**Disqualification triggers** — walk away politely:

- "We're not shipping AI to production yet." → Wrong stage. Come back in 6 months.
- "We want a better Zapier UI." → Wrong category. Refer them to Zapier or n8n.
- "We need an on-prem / air-gapped install." → Out of scope for v1. Add to a "future enterprise" list; don't oversell.
- "We're evaluating five vendors and need a 50-question RFP." → Wrong stage for a private-beta product. Politely decline and ask to reconnect when they've narrowed to a shortlist.

### Stage 3 — Demo + technical Q&A (30 min)

Run the recommended demo for the segment (4–5 minutes) live or play the recorded version, then 25 minutes of Q&A. Cover the segment's top 3 objections from the segment card. Send a follow-up email same day with: (a) the recording link or narrative pre-read, (b) a 2-paragraph recap of how Janusly maps to their specific pain, (c) the next step (trial setup).

**Hypothesis demo-to-trial conversion:** 30–50% for qualified prospects.

### Stage 4 — Trial setup (week 2)

Help the prospect wire one of their real workflows. The flagship `failed-workflow-recovery` template is the recommended "first thing they break on purpose" so they see the Recovery Center loop end-to-end on their own data.

**Hypothesis time-to-first-recovered-run:** 3–7 days from trial start. The trial is "real" when their team has used the Recovery Center to fix a real failure at least once.

### Stage 5 — Conversion (week 3–6)

Once a real recovery has happened, the prospect either champions Janusly internally or churns out. Conversion drivers:

- The user (ops lead / SRE / agency engineer) wants to keep using it daily.
- The buyer (COO / VP Eng / agency founder) has seen the MTTR metric improve on a real workflow.
- The contract conversation is about scope and pricing, not category-fit.

**Hypothesis time-to-close:** ~30 days for B2B startups + engineering teams, ~45 days for AI builders/agencies (longer compliance check). Validate via ENG-093.

### What to do when a deal stalls

- Stalled in Stage 2 (no demo booked after discovery): they didn't believe the demo would be relevant. Re-pitch with a tighter segment-fit demo angle.
- Stalled in Stage 4 (trial wired but no real-failure-recovery yet): the user hasn't tried to break it. Schedule a 30-min "let's intentionally break a workflow together" call.
- Stalled in Stage 5 (real recovery happened, but no signature): pricing is the friction. Pull in the founder or whoever owns ENG-068 packaging.

---

## Persona-to-segment mapping (in-call cheat sheet)

When an inbound lead's job title is on screen, use this table to pick the right segment card before the call starts. The persona names anchored in **bold** are lifted verbatim from the demos' `Audience` fields (see [`docs/demos/`](../demos/)) — those are the roles each demo was authored for, so the demo lands cleanly. Adjacent role titles in the same segment (founders, VPs, ICs in the same org function) appear without bold and inherit the segment + lead demo of the anchored persona.

| Persona / job title | Canonical segment | Lead demo |
| --- | --- | --- |
| Founder, COO, VP Operations | B2B startups with ops workflows | refund-triage |
| Ops lead, finance ops associate | B2B startups with ops workflows | refund-triage |
| Customer-support team lead | B2B startups with ops workflows | refund-triage |
| **Revenue ops / finance ops / customer-support team leads** | B2B startups with ops workflows | refund-triage → failed-workflow-recovery |
| **Enterprise ops / finance ops / business analytics buyers** | B2B startups with ops workflows (enterprise extension) | [monthly-report-pdf](../demos/monthly-report-pdf.md) (narrative only) |
| **Scale / data-volume buyers / customer-success and growth teams** | B2B startups with ops workflows (scale extension) | [bulk-classify-loop](../demos/bulk-classify-loop.md) (narrative only) |
| VP Engineering, Director of Platform | Engineering/support teams | incident-triage |
| Engineering Manager, on-call manager | Engineering/support teams | incident-triage |
| **SRE / on-call engineering managers / operations leads** | Engineering/support teams | incident-triage → failed-workflow-recovery |
| Customer-support engineering lead | Engineering/support teams | incident-triage |
| Agency founder, tech lead, VP delivery | AI builders/agencies | [multi-agent-decision](../demos/multi-agent-decision.md) (narrative only) |
| **AI builders / agencies / technical AI buyers** | AI builders/agencies | [multi-agent-decision](../demos/multi-agent-decision.md) → [mcp-notion-summary](../demos/mcp-notion-summary.md) |
| Founder of an AI-product startup | AI builders/agencies | [multi-agent-decision](../demos/multi-agent-decision.md) |
| **AI builders / ecosystem buyers / technical architects evaluating MCP** | AI builders/agencies (ecosystem) | [mcp-notion-summary](../demos/mcp-notion-summary.md) (narrative only) |

If a title is not on this table, the prospect is probably not segment-fit. Run a quick discovery to confirm, but the default is "polite no" rather than "force-fit one of the three segments."

The "(narrative only)" tag means the demo has a narrative doc in [`docs/demos/`](../demos/) but no recording script yet — only the three flagship demos (incident-triage, refund-triage, failed-workflow-recovery) have second-by-second recording scripts under [`recording-scripts/`](recording-scripts/). For supporting demos, walk them live or send the narrative doc as pre-read.

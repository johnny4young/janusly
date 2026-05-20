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

---

## Versión en español

La versión paralela en castellano. Misma estructura, mismos 3 segmentos canónicos, mismas líneas de objeción, mismas plantillas de outreach. Las reglas de vocabulario y voz están en [`narrative.md` Versión en español](narrative.md#versión-en-español); este doc las honra. Identificadores cross-cutting de la stack de ventas — los nombres canónicos de segmento (`B2B startups with ops workflows` / `Engineering/support teams` / `AI builders/agencies`), los demo filenames (`refund-triage`, `incident-triage`, `failed-workflow-recovery`, `multi-agent-decision`, `mcp-notion-summary`, `monthly-report-pdf`, `bulk-classify-loop`), los placeholders de mail-merge (`[name]`, `[company]`, `[link]`, `[agency]`), y los IDs de ticket (`ENG-068`, `ENG-093`) — quedan en inglés en ambos idiomas porque son identificadores, no texto traducible.

---

### Segmento 1 — B2B startups with ops workflows

> Automatiza flujos de ops sin perder control cuando hay AI involucrada.

El segmento de movimiento más rápido, con el dolor más fuerte. Compañías SaaS Series A–C, 20–200 empleados, donde el trabajo de ops, finance y support superó las hojas de cálculo pero nadie tiene tiempo de construir una plataforma de flujos desde cero.

#### Pain points (en palabras del comprador)

- "Las excepciones de billing me despiertan. Procesamos refunds en tres lugares — Stripe, nuestra herramienta interna, customer support — y los tres no se ponen de acuerdo sobre cuál es la fuente de verdad."
- "Cada refund son los mismos cinco clicks. Mi líder de ops gasta 90 minutos por día en eso."
- "Cuando algo se rompe a las 3am, el ingeniero de guardia pinguea al líder de ops, que pinguea al equipo de plataforma, que tiene que descubrir en qué thread de Slack quedó el último estado funcional. Media hora de toil antes de que alguien toque código."
- "Probamos Zapier para lo simple. Funciona hasta que un paso falla — y ahí no tenemos idea qué falló, qué reintentamos, ni qué cambió."
- "Necesitamos un audit trail de quién aprobó qué, porque finance pregunta en cierre de trimestre y hoy hacemos screenshots de Slack."

#### Comprador y usuario

- **Comprador (firma la PO):** Fundador / COO / VP de Operaciones. Es dueño del presupuesto de tooling de ops y siente el dolor en carne propia.
- **Usuario (usa el producto a diario):** Líder de ops, finance ops associate, líder de customer-support. Construye / aprueba / monitorea flujos; arma los reportes de audit en cierre de trimestre.

El comprador casi no usa el producto después del primer mes. El usuario es la señal de retención — si el líder de ops abre Janusly a diario, el contrato se renueva.

#### Ángulo del demo

- **Arranca con:** [`refund-triage.md`](recording-scripts/refund-triage.md) — la historia human-in-the-loop (webhook → AI summary → aprobación humana → webhook firmado a billing → email) es el match más cercano a lo que hacen manualmente hoy.
- **Sigue con (si es técnico):** [`failed-workflow-recovery.md`](recording-scripts/failed-workflow-recovery.md) — el demo de la cuña. "Y acá ves qué pasa cuando el call a billing falla." Dos caminos de recuperación, validación en sandbox, replay.
- **Salta:** los demos de AI builder (multi-agent, MCP) — irrelevantes para el dolor de este segmento.

#### Manejo de objeciones

- **"Ya tengo Zapier."** "Zapier es genial cuando la pregunta es '¿cómo conecto apps SaaS que ya funcionan?' Nosotros somos la capa a la que vas cuando una de esas apps falla — Zapier no te ayuda cuando Stripe devuelve un 401 o tu API de billing rota una credencial. Prueba nuestro demo de recovery por dos minutos; vas a ver la diferencia inmediatamente."
- **"Los flujos AI son demasiado riesgosos para finance/billing."** "De acuerdo — por eso la puerta de aprobación humana es un nodo de primera clase, y cada parche pasa por validación en sandbox antes de tocar producción. La AI propone; tu líder de ops decide. No lanzamos 'autónomo' para nada de billing."
- **"¿Mis ingenieros no pueden construir esto en un fin de semana?"** "Pueden construir el happy path en un fin de semana. La capa de recovery — DLQ, explicaciones de falla estructuradas, sandbox replay, audit log, version rollback — es la parte que toma seis meses y tres iteraciones. Ese trabajo ya lo hicimos nosotros."

#### Copy del primer outreach

**Cold email (3 párrafos):**

> Subject: ¿90 minutos al día de toil con refunds?
>
> Hola [name] — vi que estás manejando ops en [company]. Hipótesis rápida: si tu equipo procesa refunds/excepciones de billing/escalaciones manualmente en tres herramientas distintas, probablemente estás perdiendo ~90 minutos al día de tiempo de un líder de ops. Y cuando algo se rompe a las 3am, pierdes media hora de un ingeniero también.
>
> Janusly es la plataforma de flujos AI recovery-first que construimos para este dolor exacto — tu líder de ops aprueba el call en un click, el webhook de billing se dispara con firma HMAC, y cuando falla (porque eventualmente va a fallar), la AI te muestra qué se rompió y ofrece un fix que puedes validar en un sandbox antes de reintentar.
>
> Grabación de 4 minutos del flujo refund-triage: [link to refund-triage recording]. ¿Vale 15 minutos para caminarlo juntos la próxima semana?

**LinkedIn DM (2 oraciones):**

> [name] — vi que estás manejando ops en [company]. Construimos una plataforma de flujos AI recovery-first para refunds / billing / escalaciones; el demo son 4 minutos y va a resonar inmediatamente o no va a resonar. ¿Te paso el link?

#### Métrica de éxito

- **Métrica principal:** Tiempo Medio de Recuperación (MTTR) de runs fallidos de billing/refund/escalación. Baseline ~30 min (triage manual); target <3 min (loop del Centro de Recuperación).
- **Indicador adelantado:** Aprobaciones procesadas por hora de líder de ops. Baseline ~4/hora (click manual); target 30+/hora (aprobación en un click desde Janusly).
- **Señal de retención:** El líder de ops abre Janusly ≥3 días/semana en el mes 2.

---

### Segmento 2 — Engineering/support teams

> Convierte incidentes y escalaciones en flujos explicables con recovery construido adentro.

Engineering managers, SREs y equipos de plataforma en compañías donde el volumen de reportes de bugs de clientes y alertas de infra superó al triage manual. Suele ser la misma compañía que el Segmento 1, pero el comprador es otra persona — el engineering manager en vez del COO.

#### Pain points (en palabras del comprador)

- "Cada incidente es el mismo triage: leer la alerta, encontrar el servicio afectado, abrir el issue en GitHub, pinguear al on-call, pegar el link en el canal de Slack correcto. Quince minutos de toil por incidente, y tenemos ocho a la semana."
- "Nuestra rotación de on-call está quemada. La mitad de las páginas son paperwork que podría automatizarse, pero las herramientas tipo Zapier no manejan nuestro auth / nuestra infra / nuestro contexto."
- "Cuando entra una escalación de customer-support, rebota entre tres ingenieros antes de que alguien la take ownership. Para entonces el cliente ya churneó."
- "Intentamos construir tooling interno. La primera versión funcionó; en el momento que un paso empezó a fallar intermitentemente descubrimos que no teníamos historia de recovery ni audit log."
- "No confiamos en la AI para actuar en producción todavía. Confiamos en que resuma, clasifique, redacte — pero el humano sigue siendo el que aprieta el botón."

#### Comprador y usuario

- **Comprador (firma la PO):** VP de Engineering / Engineering Manager / Director de Plataforma. Es dueño de la salud de la rotación de on-call, del presupuesto de SRE, y de las decisiones de tooling de plataforma.
- **Usuario (usa el producto a diario):** SRE, ingeniero de on-call, developer de plataforma, líder de customer-support engineering. Cablean flujos, aprueban runs en el diálogo de recovery, leen el timeline a las 3am.

El usuario acá es más técnico que en el Segmento 1 — va a inspeccionar el DAG del flujo, preguntar sobre el runtime, querer ver el schema del audit log. Trae el talk-track de engineering manager.

#### Ángulo del demo

- **Arranca con:** [`incident-triage.md`](recording-scripts/incident-triage.md) — webhook entra, AI summarize, issue en GitHub, notificación en Slack. La estructura espeja su tooling interno pero el paso de AI + el audit trail son nuevos para ellos.
- **Sigue con:** [`failed-workflow-recovery.md`](recording-scripts/failed-workflow-recovery.md) — el demo de la cuña. Crítico para este segmento porque tienen un baseline alto de "intentamos construirlo"; el loop del Centro de Recuperación es la parte que su tooling interno no tenía.
- **Salta:** Demos de multi-agent / MCP a menos que mencionen específicamente "estamos construyendo agents." Refund-triage también es prioridad más baja — no son los que aprueban refunds.

#### Manejo de objeciones

- **"Ya tenemos un runbook / un Lambda / un Slack bot para esto."** "Entonces tienes el happy path. Muéstrame qué pasa cuando el webhook de Slack te limita por rate, o cuando la credencial de GitHub rota — ¿tu runbook explica qué se rompió, o lees el stack trace? Nosotros somos la capa que cierra ese gap. El flujo que ya construiste sigue funcionando; Janusly lo envuelve con observabilidad + recovery."
- **"¿En qué se diferencia esto de Temporal / Airflow / Inngest?"** "Esos son runtimes de flujos durables — fundación sólida. Nosotros también, pero el diferenciador es la superficie del operador: fallas AI-explicadas, parches AI-sugeridos con scores de confianza, validación en sandbox antes de guardar, version rollback en un click. Misma capa de runtime, más la capa de recovery encima."
- **"No estamos listos para meter AI en el loop de on-call."** "Nosotros tampoco. La AI propone el fix; el humano revisa el diff, valida en un sandbox, y hace click en aplicar. No hay acción AI-autónoma contra producción en nuestro default. Si quieres autónomo después, los mismos primitivos lo soportan — pero la puerta es tuya para levantar."

#### Copy del primer outreach

**Cold email (3 párrafos):**

> Subject: Ocho incidentes a la semana — ¿cuántos son paperwork?
>
> Hola [name] — engineering managers con los que hablé recientemente dicen algo así: "la mitad de las páginas de mi on-call son paperwork que podría automatizar, pero no confío en herramientas off-the-shelf con nuestro auth o nuestro contexto." ¿Es una lectura justa para [company]?
>
> Janusly es la plataforma de flujos AI que construimos para equipos de engineering que superaron Zapier pero no quieren seguir construyendo tooling interno para incident triage / routing de escalaciones / automatización de status page. El diferenciador es la capa de recovery — cuando un paso falla, la AI explica qué se rompió y propone un fix que puedes validar en un sandbox antes de guardar. Audit log por acción, version rollback en un click, multi-tenant scope en cada query.
>
> Grabación de 4 minutos del flujo de incident-triage: [link]. ¿Vale 15 minutos la próxima semana si resuena?

**LinkedIn DM (2 oraciones):**

> [name] — equipo de engineering en [company]. Construimos una plataforma de flujos AI con un runtime recovery-first; grabación de 4 min camina por el flujo de incident-triage. Si ya intentaste construir algo así internamente, la capa de recovery es probablemente la parte a la que no llegaste.

#### Métrica de éxito

- **Métrica principal:** Tiempo Medio de Recuperación (MTTR) de runs de flujos fallidos. Baseline ~45 min (paginar on-call, leer trace, redeploy, reintentar); target <3 min (loop del Centro de Recuperación).
- **Indicador adelantado:** Incidentes auto-triajados por semana (sin paginar on-call). Baseline 0 (todo pagina); target 5+/semana.
- **Señal de retención:** El SRE abre el Centro de Recuperación ≥1 vez por turno de on-call en el mes 2.

---

### Segmento 3 — AI builders/agencies

> Shippea flujos AI de cliente con runtime, ops visual, MCP y recovery.

Fundadores y tech leads en agencias de AI, AI-product startups, y consultoras que lanzan flujos AI custom para clientes. Ellos escriben el código del agent; necesitan el runtime, el audit log, y la historia de recovery para sentirse cómodos poniendo el flujo de billing del cliente encima.

#### Pain points (en palabras del comprador)

- "Hice un demo de agent excelente para el cliente. Ahora quieren ponerlo en producción y me di cuenta de que no tengo nada — no runtime, no audit log, no manera de rollback cuando el modelo se porta mal."
- "Cada cliente quiere 'AI pero governable.' Sigo escribiendo el mismo glue de recovery: retries, DLQ, replay, historia de versiones. Son seis semanas de trabajo por cliente y lo revendemos mal."
- "MCP va a estar en todos lados en 12 meses. Quiero que los flujos de mi agencia consuman servidores MCP sin que yo tenga que cablear cada uno."
- "Necesito mostrarle al cliente un timeline de run que no sea solo para ingenieros. Estoy cansado de pegar logs en Notion."
- "Cuando el abogado del cliente pregunta '¿quién aprobó esta acción de AI?', quiero apuntarle a un audit log, no decir 'mmm, déjame revisar Slack.'"

#### Comprador y usuario

- **Comprador (firma la PO):** Fundador de la agencia / tech lead / VP de delivery. Gana en velocidad de go-live de cliente; su margen se achica cada semana de glue code que reescribe por proyecto.
- **Usuario (usa el producto a diario):** AI engineer senior / solution architect / "la persona que publicó el demo." Prototipa flujos, configura conexiones MCP, arma el dashboard de audit-log para el cliente.

El usuario es el más técnico de los tres segmentos. Va a preguntar por el primitivo multi-agent, la abstracción del provider de LLM, el write-consent de MCP, y la forma del envelope estructural de patch. Trae el talk-track de comprador técnico-AI.

#### Ángulo del demo

- **Arranca con:** [`multi-agent-decision`](../demos/multi-agent-decision.md) — primitivo de debate de tres agents, timeline observable por agent. El framing "orquestación que Zapier y n8n no pueden reproducir" aterriza fuerte acá. Solo doc narrativo; no hay recording script todavía (solo los 3 flagships tienen recording scripts) — recórrelo en vivo o manda el narrativo como tarea para casa.
- **Sigue con:** [`mcp-notion-summary`](../demos/mcp-notion-summary.md) — la historia del MCP client. Cablea una conexión una vez, cada flujo la usa. Diferenciador vs construir plumbing de MCP por-cliente. Después [`failed-workflow-recovery.md`](recording-scripts/failed-workflow-recovery.md) para el loop de recovery (este SÍ es un recording script — corre end-to-end).
- **Salta:** Refund-triage e incident-triage son muy genéricos para este segmento — quieren ver los primitivos AI-native, no los casos de uso de SaaS-glue.

#### Manejo de objeciones

- **"Ya uso LangChain / LangGraph / un runtime custom."** "Esas son librerías — sólidas para prototipar. Nosotros somos el runtime de producción que las envuelve: estado de DAG persistente, audit estructurado, recovery AI-sugerido, version rollback. Quédate con tu código de agent; nosotros te damos la superficie para operarlo después del handoff al cliente."
- **"El compliance del cliente no va a aprobar una plataforma de terceros manejando sus runs de AI."** "El multi-tenant scope está enforced en cada query, el audit log es por-org-fila-por-acción, el material de secret vive en env (guardamos solo el nombre de la env var, nunca el valor del secret), SSO/SCIM vía WorkOS. Si su equipo de compliance pregunta cosas específicas, tenemos respuestas."
- **"¿Puedo white-label / embeber Janusly en el producto de mi agencia?"** "No en v1 — estamos enfocados en venta directa. Pero exponemos cada primitivo vía API y MCP; puedes construir dashboards del lado de la agencia que lean nuestro timeline de run. White-label es una conversación futura."

#### Copy del primer outreach

**Cold email (3 párrafos):**

> Subject: ¿Seis semanas de glue de recovery por cliente?
>
> Hola [name] — líderes de agencias AI con los que hablé recientemente vienen diciendo lo mismo: "mis ingenieros lanzan un demo excelente, después gastamos seis semanas por cliente escribiendo glue de retry / DLQ / audit / rollback porque el runtime del prototype no sobrevive producción." ¿Es una forma familiar para [agency]?
>
> Janusly es el runtime de producción de flujos AI que construimos para que eso deje de ser tu problema. Ops visual del DAG, estado de run persistente, audit log estructurado, parches AI-sugeridos con validación en sandbox, MCP client + server, primitivo multi-agent. Tus ingenieros escriben el código del agent; nosotros somos dueños de la superficie que el equipo de compliance del cliente te va a preguntar.
>
> Walkthrough corto del flujo de decisión multi-agent: [link to multi-agent narrative]. Si el glue de recovery es el cuello de botella de tu margen de delivery, vale 15 minutos.

**LinkedIn DM (2 oraciones):**

> [name] — líder de agencia AI en [agency]. Construimos el runtime de producción para el glue de recovery / audit / rollback que probablemente estás reescribiendo por cliente. Walkthrough corto de multi-agent; si no resuena el primer minuto, puedes cerrarlo.

#### Métrica de éxito

- **Métrica principal:** Tiempo-de-go-live-con-cliente con audit + recovery. Baseline ~6 semanas (glue custom por proyecto); target <1 semana (pon Janusly, configura org, lanza).
- **Indicador adelantado:** Cantidad de orgs de cliente corriendo en Janusly con zero glue-code en el mes 2.
- **Señal de retención:** La agencia usa Janusly para ≥2 proyectos de cliente dentro de los 90 días de firma.

---

### Resumen del motion de ventas

Cómo un deal de Janusly se mueve de primer touch a contrato cerrado. Los números abajo son **hipótesis v1 a validar por ENG-093** (el experimento de private-beta MTTR con 3 design partners) — ajustar después de que aterricen los datos reales.

#### Etapa 1 — Outreach en frío (día 0)

Cold email o LinkedIn DM, según el copy específico de cada segmento arriba. Abre con un dolor que el segmento reconozca en su propio lenguaje. Cierra con el demo asset relevante (grabación de 4 minutos para flagships, narrativo de pre-lectura para demos de apoyo) como el único CTA. No presentes "charlemos" sin un asset concreto adjunto.

**Hipótesis de tasa de respuesta:** 5–10% para warm cold (segmento-fit + individuo nombrado), 1–3% para spray-and-pray. Validar vía ENG-093.

#### Etapa 2 — Llamada de discovery (15 min)

Si el prospect responde, agenda una discovery de 15 minutos. Objetivos:

1. Confirmar segmento-fit (la tabla persona-to-segment al final del doc es el cheat sheet en llamada).
2. Identificar el dolor específico — excepciones de billing / incident triage / trabajo con clientes de agencia / otra cosa?
3. Elegir el demo con el que arrancar basado en la respuesta (refund-triage / incident-triage / multi-agent + MCP).
4. Bookear el demo para 4–7 días después (les da tiempo a invitar a su evaluador técnico).

**Disqualification triggers** — caminar afuera amablemente:

- "No estamos lanzando AI a producción todavía." → Etapa equivocada. Vuelve en 6 meses.
- "Queremos una mejor UI de Zapier." → Categoría equivocada. Refiérelos a Zapier o n8n.
- "Necesitamos un install on-prem / air-gapped." → Fuera de scope para v1. Agrégalos a una lista "future enterprise"; no sobrevendas.
- "Estamos evaluando cinco vendors y necesitamos un RFP de 50 preguntas." → Etapa equivocada para un producto en private-beta. Declinar amablemente y pedir reconectar cuando hayan reducido a un shortlist.

#### Etapa 3 — Demo + Q&A técnico (30 min)

Corre el demo recomendado para el segmento (4–5 minutos) en vivo o pasa la versión grabada, después 25 minutos de Q&A. Cubre las 3 objeciones top del segmento desde la tarjeta del segmento. Manda un email de follow-up el mismo día con: (a) el link de la grabación o el narrativo de pre-lectura, (b) un recap de 2 párrafos de cómo Janusly mapea a su dolor específico, (c) el próximo paso (setup del trial).

**Hipótesis de conversión demo-a-trial:** 30–50% para prospects calificados.

#### Etapa 4 — Setup del trial (semana 2)

Ayuda al prospect a cablear uno de sus flujos reales. El template flagship `failed-workflow-recovery` es el "lo primero que rompen a propósito" recomendado para que vean el loop del Centro de Recuperación end-to-end con sus propios datos.

**Hipótesis de tiempo-al-primer-recovered-run:** 3–7 días desde el arranque del trial. El trial es "real" cuando su equipo usó el Centro de Recuperación para arreglar una falla real al menos una vez.

#### Etapa 5 — Conversión (semana 3–6)

Una vez que un recovery real pasó, el prospect o se vuelve campeón interno de Janusly o se churnea. Drivers de conversión:

- El usuario (líder de ops / SRE / ingeniero de agencia) quiere seguir usándolo a diario.
- El comprador (COO / VP Eng / fundador de agencia) vio la métrica de MTTR mejorar en un flujo real.
- La conversación de contrato es sobre scope y precio, no sobre fit-de-categoría.

**Hipótesis de tiempo-al-cierre:** ~30 días para startups B2B + equipos de engineering, ~45 días para AI builders/agencies (compliance check más largo). Validar vía ENG-093.

#### Qué hacer cuando un deal se estanca

- Estancado en Etapa 2 (no se bookeó demo después de la discovery): no creyeron que el demo iba a ser relevante. Re-pitch con un ángulo de demo más segmento-fit.
- Estancado en Etapa 4 (trial cableado pero sin real-failure-recovery todavía): el usuario no intentó romperlo. Agenda una llamada de 30 min "rompamos un flujo a propósito juntos."
- Estancado en Etapa 5 (recovery real pasó, pero no hay firma): precio es la fricción. Trae al fundador o a quien sea dueño del packaging de ENG-068.

---

### Mapa persona → segmento (cheat sheet en llamada)

Cuando el job title de un lead inbound está en pantalla, usa esta tabla para elegir la tarjeta de segmento correcta antes de que arranque la llamada. Los nombres de persona en **negrita** están lifted verbatim de los campos `Audience` de los demos (ver [`docs/demos/`](../demos/)) — esos son los roles para los que cada demo fue escrito, así que el demo aterriza limpio. Títulos adyacentes en el mismo segmento (fundadores, VPs, ICs en la misma función organizacional) aparecen sin negrita y heredan el segmento + lead demo de la persona ancla.

| Persona / job title | Canonical segment | Lead demo |
| --- | --- | --- |
| Fundador, COO, VP de Operaciones | B2B startups with ops workflows | refund-triage |
| Líder de ops, finance ops associate | B2B startups with ops workflows | refund-triage |
| Líder de customer-support | B2B startups with ops workflows | refund-triage |
| **Líderes de revenue ops / finance ops / customer-support** | B2B startups with ops workflows | refund-triage → failed-workflow-recovery |
| **Compradores de enterprise ops / finance ops / business analytics** | B2B startups with ops workflows (extensión enterprise) | [monthly-report-pdf](../demos/monthly-report-pdf.md) (solo narrativo) |
| **Compradores de scale / data-volume / equipos de customer-success y growth** | B2B startups with ops workflows (extensión scale) | [bulk-classify-loop](../demos/bulk-classify-loop.md) (solo narrativo) |
| VP de Engineering, Director de Plataforma | Engineering/support teams | incident-triage |
| Engineering Manager, manager de on-call | Engineering/support teams | incident-triage |
| **SRE / engineering managers de on-call / líderes de operaciones** | Engineering/support teams | incident-triage → failed-workflow-recovery |
| Líder de customer-support engineering | Engineering/support teams | incident-triage |
| Fundador de agencia, tech lead, VP de delivery | AI builders/agencies | [multi-agent-decision](../demos/multi-agent-decision.md) (solo narrativo) |
| **AI builders / agencias / compradores técnico-AI** | AI builders/agencies | [multi-agent-decision](../demos/multi-agent-decision.md) → [mcp-notion-summary](../demos/mcp-notion-summary.md) |
| Fundador de un AI-product startup | AI builders/agencies | [multi-agent-decision](../demos/multi-agent-decision.md) |
| **AI builders / compradores de ecosistema / arquitectos técnicos evaluando MCP** | AI builders/agencies (ecosistema) | [mcp-notion-summary](../demos/mcp-notion-summary.md) (solo narrativo) |

Si un título no está en esta tabla, el prospect probablemente no es segmento-fit. Corre una discovery rápida para confirmar, pero el default es "no amable" más que "forzar-fit con uno de los tres segmentos."

El tag "(solo narrativo)" significa que el demo tiene un doc narrativo en [`docs/demos/`](../demos/) pero todavía no tiene recording script — solo los tres demos flagship (incident-triage, refund-triage, failed-workflow-recovery) tienen recording scripts segundo-a-segundo bajo [`recording-scripts/`](recording-scripts/). Para demos de apoyo, recórrelos en vivo o manda el doc narrativo como pre-lectura.

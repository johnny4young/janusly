# Janusly pricing strategy

The canonical **packaging + value-metric reference** for Janusly. The downstream consumers: founders / sales answering "how much does it cost?" without committing to a number prematurely, and the future ENG-068-followup work that fills in dollar amounts once ENG-093 (private-beta MTTR experiment) data lands.

**Strategy lives in [`docs/PLAN.md` §16.7](../PLAN.md).** **Brand voice in [`docs/marketing/narrative.md`](narrative.md).** **Segment definitions in [`docs/marketing/icp.md`](icp.md).** This doc is the **structural layer** — names the tiers, what each contains, what value metric drives each, where the self-host / managed boundary sits.

**Explicit "no dollar amounts" note.** This document ships **structure without prices**. The reason: ENG-093's private-beta data is what tightens real numbers; committing to a price without data anchors us to a wrong one. Until ENG-093 closes, sales conversations answer "how much" with `"we'll work with your team on pricing once we both know the workload"` — driven by the discovery-call segment fit + estimated run volume from [`docs/marketing/icp.md`](icp.md).

---

## Section A — Pricing principles

The philosophy. Every later section is derived from these.

- **Recovery is the wedge, not integration count.** The AI Recovery Pack is an **add-on**, not a baseline feature, so customers who buy the wedge get the wedge. Other workflow platforms price on connector count; we don't.
- **Self-host is full-runtime, but license language stays undecided.** Everything except managed-cloud features and enterprise controls runs in self-host. We compete by being good, not by gating the recovery loop; do not call it open-source/open-core until the license decision closes.
- **Value metric should follow the operator's pain.** A team that runs 50 incidents/week pays differently than a team that runs 50,000 customer classifications/week. We propose 3 candidate metrics (per-seat, per-recovered-run, per-AI-call) and name which fits each tier best.
- **Honest about today vs destination.** Tiers we ship today get clear feature lists. Enterprise gets a clear feature list **plus** explicit `(shipped)` / `(roadmap)` tags for parts not yet productionized. Same convention `narrative.md` uses for "we are honest about today vs destination."
- **Never per-LLM-token, per-connector, per-workflow-step.** These metrics either tie us to a provider's price card (LLM tokens to Anthropic), copy the wrong wedge (Zapier's connector count), or surface too granular for buyers to predict (per-step). See Section D for the full anti-list.

---

## Section B — Free / self-host boundary

The philosophical centerpiece. AC names this explicitly. Engineering reality (from `AGENTS.md`) is the source.

### What runs in self-host (full-runtime, license TBD)

- The full runtime — Postgres + Redis + BullMQ + worker + API + web. One `pnpm dev` brings everything up in <5 min.
- Workflow DSL + DAG editor (React Flow canvas).
- **Recovery Center** — the headline feature. Full DLQ, failure-signature clustering, sandbox validation, version rollback. We do not gate the recovery loop.
- Multi-tenant scoping at the engine level (a single self-host instance can host one org by design — multi-org isolation across teams is a Team Cloud feature, not a runtime feature).
- Integration tools — Slack, GitHub, email (via Resend/SendGrid keys the operator provides), signed webhook.
- LLM client — operator brings their own Anthropic key. OpenAI remains registered for future verification, not current production use. AI fallback contract works even without a key.
- MCP client + server.
- Audit log per action.
- OpenTelemetry traces + meters (`service.name="janusly"`).

### What requires Team Cloud or up

- Managed runtime — we host Postgres + Redis + worker; the operator stops being an SRE.
- Shared organization with cross-team tenant isolation (real multi-org behavior, not single-org self-host).
- Managed mailer (Resend / SendGrid keys hosted by Janusly, not the customer).
- Managed object store for PDF artifacts (S3 / R2 / similar hosted by Janusly).
- Uptime SLA (concrete numbers TBD per tier).
- Central billing — one invoice for the team.

### What requires Business or up

- RBAC custom roles + permission overrides (the per-org custom-roles feature from AGENTS.md).
- Budget governance + per-workflow budget gating.
- Recovery feedback analytics (cross-workflow rollups of accept/reject patterns).
- Failure Cluster dashboards with cross-workflow grouping.
- Usage + cost reporting per org / per workflow.
- Per-org rate limit overrides.

### What requires Enterprise

- SSO (SAML / OIDC via WorkOS) `(shipped)`.
- SCIM Directory Sync `(shipped)`.
- Isolated dedicated environments (single-tenant managed cloud — separate Postgres + Redis + worker + API instances per Enterprise customer) `(packaging target; deployment playbook/SLA still contract-scoped until productionized)`.
- Custom retention policies on `audit_logs` / `run_events` / `usage_events` beyond defaults `(roadmap; PLAN §11 still tracks soft delete + retention windows as unfinished)`.
- Private VPC peering `(roadmap; available case-by-case for design partners until productionized)`.
- Named-account support + technical account manager (TAM) `(operational; named human assigned at contract sign)`.
- Security review with named POC `(operational; vendor-questionnaire turnaround tracked)`.

---

## Section C — Tier-by-tier breakdown

### C.1 — Developer / Self-host

- **Audience:** technical individuals + small teams that operate their own infra.
- **What's included:** the full self-host runtime per Section B; full Recovery Center; DAG editor; integration tools; MCP client + server; bring-your-own-key LLM.
- **What's NOT included:** managed runtime (operator runs Postgres / Redis themselves); shared org tenant isolation; SSO; SCIM; managed mailer; managed object store; uptime SLAs; Janusly-side billing.
- **Value metric candidate:** **free.** We don't gate the recovery loop. Period.
- **Expected use case:** a single developer ships a workflow in self-host, gets the full Recovery Center experience for free, hits the boundary when they want to add teammates or stop running their own Postgres.
- **Conversion path:** developer hits a team-size or managed-infra need → upgrade to Team Cloud.

### C.2 — Team Cloud

- **Audience:** B2B startups with ops workflows — **Segment 1** of `icp.md` ("Founder / COO / VP Operations" as buyer, "Ops lead / finance ops / customer-support team lead" as user).
- **What's included:** managed runtime (Janusly hosts Postgres + Redis + worker), shared org with team members + cross-team tenant isolation, managed mailer + managed object store, basic uptime SLA, central billing (one invoice for the team).
- **What's NOT included:** RBAC custom roles + permission overrides; SSO; SCIM; isolated environments; per-workflow budget governance.
- **Value metric candidates:**
  1. **Per-seat** — anchored on the icp.md retention signal ("Ops lead opens Janusly ≥3 days/week"). Buyer can predict cost based on team size.
  2. **Per-recovered-run** — anchored on the master metric (MTTR for failed automations). Reads "you pay when we save you toil." Risk: buyer can't predict the bill until they know failure volume.
  3. **Per-workflow-org with bundled-runs allowance** — flat per-org tier with N runs included; overage at a small unit cost. Predictable for the buyer.
  - **v1 recommendation: per-seat with a runs-allowance**, because it maps cleanest to Segment 1's retention signal and is the easiest to predict.
- **Expected pricing band:** placeholder "team-startup-friendly"; final number TBD post-ENG-093.

### C.3 — Business

- **Audience:** Engineering/support teams + larger ops orgs — **Segment 2** of `icp.md` + scale extensions of Segment 1 (e.g., the Revenue ops / Enterprise ops personas in the icp.md persona-table).
- **What's included:** Team Cloud + RBAC custom roles + permission overrides + budget governance (per-workflow budget gating) + recovery feedback analytics + Failure Cluster dashboards + cost reporting + per-org rate-limit overrides.
- **What's NOT included:** SSO; SCIM; isolated environments; private VPC; named TAM.
- **Value metric candidates:**
  1. **Per-seat with custom-role allowance** — Team Cloud's per-seat with a multiplier for custom-role usage. Buyer pays more for more team flexibility.
  2. **Per-month-recovered-incidents** — reads cleanly to engineering buyers ("X incidents auto-triaged per month = Y price").
  3. **Flat per-org with usage tiers** — simple, but doesn't reward heavy users.
  - **v1 recommendation: per-seat with custom-role allowance + recovery-volume bands.** Business buyers care about both team size and recovery throughput; the combined metric makes the contract feel proportional to both.

### C.4 — Enterprise

- **Audience:** compliance-heavy teams — finance, health, regulated industries. Larger orgs with named procurement and security review processes.
- **What's included:** Business + SSO `(shipped)` + SCIM `(shipped)` + isolated environments `(packaging target; contract-scoped until productionized)` + custom audit retention `(roadmap)` + private VPC peering `(roadmap)` + named TAM + security review with named POC.
- **What's NOT included:** anything not in the feature list above. Custom model fine-tuning is out of scope for v1 packaging until a concrete customer pull exists.
- **Value metric candidates:**
  1. **Annual contract with seat band + usage band** — predictable cost ceiling for the buyer's procurement team; seat + usage banded so heavy usage doesn't blow the budget.
  2. **Annual platform license + per-incident-recovered** — fixed platform fee + variable cost per recovery. Risk: per-incident metering reads as nickel-and-dime to compliance buyers.
  3. **Custom-negotiated** — every Enterprise contract is unique anyway.
  - **v1 recommendation: annual platform license + seat band.** Per-incident metering reads wrong for this audience. Enterprise buyers prefer "we know what we pay each year" over "it depends."

### C.5 — AI Recovery Pack (add-on, NOT a tier)

- **Important framing:** this is a **managed AI add-on**, available on Team Cloud / Business / Enterprise. **NOT** available standalone. Developer/Self-host keeps the same AI recovery surfaces through bring-your-own-key mode, but does not get Janusly-managed model spend, model procurement, or managed AI support.
- **What's included:** the AI patch-suggestion engine (`POST /ai/patch-workflow`) + AI failure explanation (`POST /ai/explain-run`) + sandbox validation gating (`replayMode: "validation"`) + recovery feedback loop (`recovery_feedback` table feeding back into prompt context) + access to Anthropic models via Janusly's managed proxy for cloud tiers.
- **What's NOT included:** custom model fine-tuning, dedicated inference capacity, model-provider switching at the per-call level (the operator gets the model Janusly contracts with).
- **Value metric candidates:**
  1. **Per-AI-call** — reads literal. Risk: ties pricing to Anthropic's per-token price card; volatility leaks to the customer.
  2. **Per-month-recoveries with AI-mode tag** — anchors on operator value ("Janusly saved us 12 outages this month") rather than provider cost.
  3. **Flat add-on tied to the base tier** — simplest. Risk: doesn't differentiate light vs heavy AI use.
  - **v1 recommendation: per-month-recoveries with AI-mode.** Maps directly to the value the operator perceives. Decouples our pricing from Anthropic's price card.

---

## Section D — Value metric candidates (cross-cutting analysis)

The same 3 candidate metrics surface across tiers. This section analyses each one's pros / cons and what it signals to the buyer.

### Candidate 1 — Per-seat

- **Pros:** predictable, familiar (every SaaS does it), easy to forecast for the buyer, scales naturally with team adoption.
- **Cons:** decouples cost from value (a 10-seat team that recovers 5 incidents/week pays the same as a 10-seat team that recovers 500/week). Caps the upside on heavy users.
- **What it signals:** "we charge for access to the platform."
- **Best fit:** Team Cloud + Business base layer.

### Candidate 2 — Per-recovered-run

- **Pros:** directly maps to the master metric (MTTR for failed automations). Aligns price with value. The story writes itself: "we charge when we save you toil."
- **Cons:** buyers can't predict the bill until they know their failure volume — and "we don't know our failure volume yet" is a common state for the buyer. Variable bills make procurement nervous.
- **What it signals:** "we charge for outcomes, not access."
- **Best fit:** Business mid-tier (combined with per-seat) and Enterprise (combined with platform license).

### Candidate 3 — Per-AI-call

- **Pros:** maps the AI cost to the AI value. The buyer pays for the AI features they use.
- **Cons:** ties our pricing to Anthropic's price card volatility. Encourages buyers to avoid AI features. Reads granular and confusing.
- **What it signals:** "we charge for AI compute."
- **Best fit:** the AI Recovery Pack add-on (where AI use IS the product) — but expressed as "per-month-recoveries-with-AI-mode" rather than raw per-call to decouple from token price.

### Recommendation matrix (which metric fits which tier)

| Tier | Recommended value metric |
| --- | --- |
| Developer / Self-host | Free; no metric. |
| Team Cloud | Per-seat with a bundled-runs allowance. |
| Business | Per-seat with custom-role allowance + recovery-volume bands. |
| Enterprise | Annual platform license + seat band. |
| AI Recovery Pack (add-on) | Per-month-recoveries with AI-mode tag. |

### What we explicitly avoid

- **Per-connector pricing.** Zapier's model. Wrong wedge — we are not selling integration count.
- **Per-workflow-step pricing.** Too granular for buyers to predict. Engineers building DAGs will resent the metric.
- **Per-LLM-token pricing.** Ties our pricing to the LLM provider's price card. If Anthropic doubles their per-token price overnight, our pricing breaks.
- **Free tier with watermarked / branded output.** Cheapens the brand for a tiny conversion lift.
- **"Enterprise" pricing on the public page.** Enterprise is "contact us" by definition; publishing a number anchors the negotiation wrong.

---

## Section E — Tier-to-segment mapping (sales cheat sheet)

For sales: when an inbound lead's segment is identified (via `icp.md`'s persona-to-segment table), this table maps to the recommended tier + whether to upsell the AI Recovery Pack.

| ICP segment | Recommended tier | Upsell AI Recovery Pack? |
| --- | --- | --- |
| **B2B startups with ops workflows** (Segment 1) | Team Cloud → Business as the team grows | Yes — refund/billing recovery loop benefits most from AI patch suggestions |
| **Engineering/support teams** (Segment 2) | Business | Yes — incident triage benefits from AI explanation and pattern clustering |
| **AI builders/agencies** (Segment 3) | Developer/Self-host for their own org + Business for client deployments | Mixed — AI builders often have their own LLM keys for client work; offer the add-on, accept "no" gracefully |

---

## Section F — Enterprise controls deep dive

Called out explicitly in the AC. Each control gets an honesty tag: `(shipped)`, `(roadmap)`, `(packaging target)`, or `(operational)`.

- **SSO via WorkOS** — SAML, OIDC, enforced-SSO per org. `(shipped — see AGENTS.md auth section: WorkOS SSO flow with HMAC-signed state, sso_state_nonces replay protection, JIT membership via verified_domains / invitations / sso_connections.)`
- **SCIM via WorkOS Directory Sync** — `(shipped — 4 tables: scim_directories / scim_user_state / scim_group_state / scim_processed_events; webhook signature verification via Stripe-style HMAC; 3 idempotency guards (replay, out-of-order, resurrection).)`
- **Custom audit retention windows** — beyond default retention on `audit_logs` / `run_events` / `usage_events`. `(roadmap; PLAN §11 still tracks soft delete + retention windows as unfinished.)`
- **Isolated dedicated environments** — single-tenant managed cloud deployment (separate Postgres + Redis + worker + API per Enterprise customer). `(packaging target; deployment playbook and SLA remain contract-scoped until productionized.)`
- **Private VPC peering** — for customers who require network-level isolation between their infrastructure and Janusly's managed cloud. `(roadmap item — available case-by-case for design partners until productionized; do not promise on the landing page.)`
- **Named-account support + technical account manager (TAM)** — a named human assigned to the relationship at contract sign. `(operational; the named person owns the relationship across renewals and is the escalation path for production issues.)`
- **Security review with named POC** — every Enterprise customer gets a named security contact on Janusly's side for vendor security questionnaires, security incidents, and audit responses. `(operational; vendor-questionnaire turnaround is tracked as an SLA.)`

---

## Section G — Pricing release plan

When do we publish actual numbers? Tied to ENG-093 completion.

- **Today (ENG-068 ships, no numbers).** Sales conversations answer "how much" with `"we'll work with your team on pricing once we both know the workload"`. The discovery-call segment fit + estimated run volume from `icp.md` is the input that lets us name a tier; the price within that tier is negotiated.
- **After ENG-093 closes.** The private-beta MTTR data + the 3 design partners' willingness-to-pay signals tighten the per-seat and per-recovered-run candidate ranges. We pick the v1 number for Team Cloud + Business and publish on the pricing page.
- **After we have 10+ paying customers on Team Cloud.** We have enough variance data to publish a public per-seat for Team Cloud + Business with confidence. Enterprise stays "contact us" indefinitely.
- **What we never publish public-facing.** Per-incident metering numbers (negotiated per contract), AI-call unit costs (tied to provider price card volatility), Enterprise minimums (anchors negotiations wrong).

---

## Section H — What's NOT in this doc

The explicit out-of-scope list. Tickets that take any of these on are separate.

- **No dollar amounts.** Per the AC ("without overcomplicating early sales" + "no billing implementation required"); ENG-093 tightens real numbers. Sales conversations name "tier" + "value metric candidate", not "$X / seat / month".
- **No Stripe / billing implementation.** Banned dep per AGENTS.md. ENG-068 is docs only. The eventual billing implementation will pick Lago, a hand-rolled invoicing flow, or another non-Stripe option.
- **No checkout flow / signup-to-billing wiring.** Future ticket once a billing provider is chosen.
- **No discount policy, no annual-vs-monthly markup, no referral program.** Pricing-operations territory; belongs to a follow-up ticket once v1 numbers are set.
- **No EULA / contract templates / Master Services Agreement.** Legal team owns those.
- **No in-product pricing-page UI localization.** The landing page itself is bilingual (ENG-066); the in-product pricing-page localization happens when that page is built. This doc IS bilingual (see the `Versión en español` block at the end); the in-product surface is separate.
- **No per-region pricing.** Regions are an Enterprise deployment topic, not a tier topic. Handled per Enterprise contract.

---

## Section I — Comparison table

Single scan-friendly table. Useful as the at-a-glance reference for the future pricing landing page.

| Feature | Developer / Self-host | Team Cloud | Business | Enterprise |
| --- | --- | --- | --- | --- |
| Workflow runtime (Postgres + BullMQ) | ✓ (self-hosted) | ✓ (managed) | ✓ (managed) | ✓ (managed) |
| Recovery Center (DLQ, failure clusters, sandbox validation, version rollback) | ✓ | ✓ | ✓ | ✓ |
| DAG editor (React Flow canvas) | ✓ | ✓ | ✓ | ✓ |
| Integration tools (Slack, GitHub, email, webhook) | ✓ | ✓ | ✓ | ✓ |
| MCP client + server | ✓ | ✓ | ✓ | ✓ |
| LLM client (bring-your-own-key on self-host) | ✓ (BYO key) | ✓ (BYO or managed) | ✓ (BYO or managed) | ✓ (BYO or managed) |
| Audit log + OpenTelemetry traces | ✓ | ✓ | ✓ | ✓ |
| Shared org with cross-team tenant isolation | — | ✓ | ✓ | ✓ |
| Managed mailer + object store | — | ✓ | ✓ | ✓ |
| Uptime SLA | — | basic | upgraded | named SLA in contract |
| Central billing | — | ✓ | ✓ | ✓ |
| RBAC custom roles + permission overrides | — | — | ✓ | ✓ |
| Budget governance + per-workflow budget gating | — | — | ✓ | ✓ |
| Recovery feedback analytics + Failure Cluster dashboards | — | — | ✓ | ✓ |
| Cost + usage reporting | — | — | ✓ | ✓ |
| SSO (SAML / OIDC via WorkOS) | — | — | — | ✓ `(shipped)` |
| SCIM Directory Sync | — | — | — | ✓ `(shipped)` |
| Isolated dedicated environments | — | — | — | `(packaging target; contract-scoped)` |
| Custom audit retention windows | — | — | — | `(roadmap)` |
| Private VPC peering | — | — | — | `(roadmap)` |
| Named TAM + security POC | — | — | — | ✓ |
| **AI Recovery Pack (managed add-on)** | — `(BYO key on self-host; no managed model spend)` | available as add-on | available as add-on | available as add-on |

**`—` = not included.** **`✓` = included.** **`(shipped)` / `(roadmap)` tags are the honesty markers** for things at the engineering boundary.

---

## Versión en español

La versión paralela en castellano del **referente canónico de empaquetado + métrica de valor** de Janusly. Misma estructura, mismas anclas, misma engineering reality. Las rutas (`POST /ai/patch-workflow`, `POST /ai/explain-run`), tablas (`recovery_feedback`, `usage_events`, `audit_logs`), nombres de tier (`Developer / Self-host`, `Team Cloud`, `Business`, `Enterprise`), identificadores de métrica (`per-seat`, `per-recovered-run`, `per-AI-call`) y nombres de productos terceros (Anthropic, WorkOS, Stripe, Slack, GitHub, Resend, SendGrid, Postgres, Redis, BullMQ, React Flow, OpenTelemetry, Zapier, n8n) quedan en inglés en ambos idiomas porque son identificadores, no texto traducible. El brand-mark "Janusly" tampoco se traduce.

Vocabulario canónico, lifted de [`narrative.md`](narrative.md) Versión en español: `autoreparable`, `Centro de Recuperación`, `flujo` / `flujo de trabajo`, `operador`. Quedan en inglés como anglicismos técnicos aceptados: `sandbox`, `rollback`, `DAG`, `MTTR`, `self-host`, `MCP`. Tono: `tú` informal, nunca `usted`. Tags de honestidad: `(en producción)` para lo que ya está publicado, `(roadmap)` para planeado, `(objetivo de empaquetado)` para diseño/contrato, `(caso a caso)` para operacional.

**Nota explícita "sin montos en dólares".** Este documento ship **estructura sin precios**. La razón: la data de la beta privada (ENG-093) es lo que ajusta los números reales; comprometernos a un precio sin data nos ancla al equivocado. Hasta que ENG-093 cierre, las conversaciones de venta responden "¿cuánto cuesta?" con `"trabajaremos con tu equipo sobre el precio una vez que ambos conozcamos el workload"` — guiado por el fit de segmento del discovery call + volumen de runs estimado desde [`icp.md`](icp.md).

### Sección A — Principios de pricing

La filosofía. Cada sección posterior se deriva de estos principios.

- **La recuperación es la cuña, no el conteo de integraciones.** El AI Recovery Pack es un **add-on**, no un feature baseline, así que los clientes que compran la cuña reciben la cuña. Otras plataformas de workflow cobran por conteo de connectors; nosotros no.
- **Self-host es full-runtime, pero el lenguaje de licencia queda sin decidir.** Todo excepto features de managed cloud y controles enterprise corre en self-host. Competimos siendo buenos, no gateando el loop de recuperación; no lo llames open-source/open-core hasta que la decisión de licencia cierre.
- **La métrica de valor debe seguir el dolor del operador.** Un equipo que corre 50 incidentes/semana paga diferente que uno que corre 50.000 clasificaciones de clientes/semana. Proponemos 3 métricas candidatas (`per-seat`, `per-recovered-run`, `per-AI-call`) y nombramos cuál encaja mejor en cada tier.
- **Honestidad entre el hoy y el destino.** Los tiers que publicamos hoy llevan listas claras de features. Enterprise lleva una lista clara de features **más** tags explícitos `(en producción)` / `(roadmap)` para las partes aún no productionizadas. Misma convención que usa `narrative.md` para "somos honestos entre el hoy y el destino".
- **Nunca `per-LLM-token`, `per-connector`, `per-workflow-step`.** Estas métricas atan al price card del provider (tokens de LLM a Anthropic), copian la cuña equivocada (conteo de connectors de Zapier), o son demasiado granulares para que el comprador prediga (`per-step`). Ver Sección D para la anti-lista completa.

### Sección B — Frontera free / self-host

El epicentro filosófico. El AC lo nombra explícitamente. La engineering reality (desde `AGENTS.md`) es la fuente.

#### Qué corre en self-host (full-runtime, licencia TBD)

- El runtime completo — Postgres + Redis + BullMQ + worker + API + web. Un `pnpm dev` levanta todo en <5 min.
- DSL de flujos + editor DAG (canvas React Flow).
- **Centro de Recuperación** — el feature headline. DLQ completo, clustering por signature de falla, validación en sandbox, rollback de versión. No gateamos el loop de recuperación.
- Scoping multi-tenant a nivel de engine (una instancia self-host puede hospedar un solo org por diseño — el aislamiento multi-org cross-team es feature de Team Cloud, no del runtime).
- Tools de integración — Slack, GitHub, email (vía keys Resend/SendGrid que provee el operador), webhook firmado.
- Cliente LLM — el operador trae su propia key de Anthropic. OpenAI sigue registrado para verificación futura, no para uso productivo actual. El contrato AI-fallback funciona incluso sin key.
- Cliente + server MCP.
- Audit log por acción.
- Trazas + metrics de OpenTelemetry (`service.name="janusly"`).

#### Qué requiere Team Cloud o superior

- Runtime managed — nosotros hospedamos Postgres + Redis + worker; el operador deja de ser SRE.
- Org compartido con aislamiento multi-tenant cross-team (comportamiento multi-org real, no el self-host de un solo org).
- Mailer managed (keys de Resend / SendGrid hospedadas por Janusly, no por el cliente).
- Object store managed para artefactos PDF (S3 / R2 / similar hospedados por Janusly).
- SLA de uptime (números concretos TBD por tier).
- Billing central — una factura para el equipo.

#### Qué requiere Business o superior

- RBAC con roles custom + overrides de permisos (el feature de per-org custom-roles desde `AGENTS.md`).
- Governance de presupuesto + budget gating por flujo.
- Analytics del feedback de recuperación (rollups cross-workflow de patrones accept/reject).
- Dashboards de Failure Cluster con agrupación cross-workflow.
- Reporting de uso + costo por org / por flujo.
- Overrides de rate limit por org.

#### Qué requiere Enterprise

- SSO (SAML / OIDC vía WorkOS) `(en producción)`.
- SCIM Directory Sync `(en producción)`.
- Ambientes dedicados aislados (managed cloud single-tenant — Postgres + Redis + worker + API separados por cliente Enterprise) `(objetivo de empaquetado; playbook de deployment/SLA siguen contract-scoped hasta productionizarse)`.
- Políticas de retención custom sobre `audit_logs` / `run_events` / `usage_events` más allá de los defaults `(roadmap; PLAN §11 sigue tracking soft delete + ventanas de retención como inacabado)`.
- VPC peering privado `(roadmap; disponible caso a caso para design partners hasta productionizarse)`.
- Soporte de cuenta nombrada + technical account manager (TAM) `(caso a caso; humano nombrado asignado al firmar contrato)`.
- Security review con POC nombrado `(caso a caso; turnaround del vendor-questionnaire tracked)`.

### Sección C — Desglose tier por tier

#### C.1 — Developer / Self-host

- **Audiencia:** individuos técnicos + equipos chicos que operan su propia infra.
- **Qué está incluido:** el runtime self-host completo según Sección B; Centro de Recuperación completo; editor DAG; tools de integración; cliente + server MCP; LLM bring-your-own-key.
- **Qué NO está incluido:** runtime managed (el operador corre su propio Postgres / Redis); aislamiento de tenant org compartido; SSO; SCIM; mailer managed; object store managed; SLAs de uptime; billing del lado Janusly.
- **Candidato a métrica de valor:** **free.** No gateamos el loop de recuperación. Punto.
- **Caso de uso esperado:** un developer solo publica un flujo en self-host, obtiene la experiencia completa del Centro de Recuperación gratis, choca con la frontera cuando quiere agregar compañeros o dejar de correr su propio Postgres.
- **Path de conversión:** developer choca con una necesidad de tamaño de equipo o infra managed → upgrade a Team Cloud.

#### C.2 — Team Cloud

- **Audiencia:** B2B startups with ops workflows — **Segmento 1** de `icp.md` ("Founder / COO / VP Operations" como comprador, "Ops lead / finance ops / customer-support team lead" como usuario).
- **Qué está incluido:** runtime managed (Janusly hospeda Postgres + Redis + worker), org compartido con miembros del equipo + aislamiento de tenant cross-team, mailer managed + object store managed, SLA básico de uptime, billing central (una factura para el equipo).
- **Qué NO está incluido:** roles custom RBAC + overrides de permisos; SSO; SCIM; ambientes aislados; governance de presupuesto por flujo.
- **Candidatos a métrica de valor:**
  1. **`per-seat`** — anclado en la señal de retención de `icp.md` ("Ops lead abre Janusly ≥3 días/semana"). El comprador puede predecir el costo basado en tamaño de equipo.
  2. **`per-recovered-run`** — anclado en la métrica maestra (MTTR para automatizaciones fallidas). Lee "pagas cuando te ahorramos toil." Riesgo: el comprador no puede predecir la cuenta hasta saber el volumen de fallas.
  3. **`per-workflow-org` con runs bundled allowance** — tier flat por org con N runs incluidos; overage a costo unitario chico. Predecible para el comprador.
  - **Recomendación v1: `per-seat` con runs allowance**, porque mapea más limpio a la señal de retención del Segmento 1 y es el más fácil de predecir.
- **Banda de precio esperada:** placeholder "team-startup-friendly"; número final TBD post-ENG-093.

#### C.3 — Business

- **Audiencia:** Engineering/support teams + orgs ops más grandes — **Segmento 2** de `icp.md` + extensiones de escala del Segmento 1 (e.g., las personas Revenue ops / Enterprise ops del persona-table de `icp.md`).
- **Qué está incluido:** Team Cloud + roles custom RBAC + overrides de permisos + governance de presupuesto (budget gating por flujo) + analytics del feedback de recuperación + dashboards de Failure Cluster + reporting de costo + overrides de rate-limit por org.
- **Qué NO está incluido:** SSO; SCIM; ambientes aislados; VPC privado; TAM nombrado.
- **Candidatos a métrica de valor:**
  1. **`per-seat` con allowance de roles custom** — el `per-seat` de Team Cloud con un multiplier por uso de roles custom. El comprador paga más por más flexibilidad de equipo.
  2. **`per-month-recovered-incidents`** — lee limpio a compradores de engineering ("X incidentes auto-triaged por mes = precio Y").
  3. **Flat per-org con tiers de uso** — simple, pero no premia a usuarios heavy.
  - **Recomendación v1: `per-seat` con allowance de roles custom + bandas de volumen de recovery.** Los compradores Business se preocupan tanto por tamaño de equipo como por throughput de recuperación; la métrica combinada hace que el contrato se sienta proporcional a ambos.

#### C.4 — Enterprise

- **Audiencia:** equipos compliance-heavy — finance, health, industrias reguladas. Orgs más grandes con procesos nombrados de procurement y security review.
- **Qué está incluido:** Business + SSO `(en producción)` + SCIM `(en producción)` + ambientes aislados `(objetivo de empaquetado; contract-scoped hasta productionizarse)` + retención de auditoría custom `(roadmap)` + VPC peering privado `(roadmap)` + TAM nombrado + security review con POC nombrado.
- **Qué NO está incluido:** cualquier cosa que no esté en la lista de features de arriba. Fine-tuning de modelos custom queda fuera de scope del empaquetado v1 hasta que exista un pull concreto del cliente.
- **Candidatos a métrica de valor:**
  1. **Contrato anual con banda de seats + banda de uso** — ceiling de costo predecible para el equipo de procurement del comprador; bandeado por seats + uso para que el uso heavy no reviente el presupuesto.
  2. **Licencia de plataforma anual + `per-incident-recovered`** — fee fijo de plataforma + costo variable por recuperación. Riesgo: metering per-incident lee como nickel-and-dime a compradores compliance.
  3. **Negociado custom** — cada contrato Enterprise es único de todos modos.
  - **Recomendación v1: licencia de plataforma anual + banda de seats.** El metering per-incident lee mal para esta audiencia. Los compradores Enterprise prefieren "sabemos cuánto pagamos cada año" sobre "depende".

#### C.5 — AI Recovery Pack (add-on, NO es un tier)

- **Framing importante:** este es un **add-on managed de AI**, disponible en Team Cloud / Business / Enterprise. **NO** disponible standalone. Developer/Self-host mantiene las mismas superficies de recovery AI a través de modo bring-your-own-key, pero no obtiene model spend managed por Janusly, procurement de modelo, ni soporte AI managed.
- **Qué está incluido:** el engine de patch suggestion AI (`POST /ai/patch-workflow`) + explicación de fallas AI (`POST /ai/explain-run`) + gating de validación en sandbox (`replayMode: "validation"`) + loop de feedback de recuperación (la tabla `recovery_feedback` alimentando de vuelta al prompt context) + acceso a modelos Anthropic vía el proxy managed de Janusly para tiers cloud.
- **Qué NO está incluido:** fine-tuning de modelos custom, capacidad de inferencia dedicada, switching de provider de modelo a nivel per-call (el operador obtiene el modelo con el que Janusly tiene contrato).
- **Candidatos a métrica de valor:**
  1. **`per-AI-call`** — lee literal. Riesgo: ata el pricing al price card per-token de Anthropic; la volatilidad le filtra al cliente.
  2. **`per-month-recoveries` con tag AI-mode** — anclado en valor del operador ("Janusly nos ahorró 12 outages este mes") en lugar de costo del provider.
  3. **Add-on flat atado al tier base** — el más simple. Riesgo: no diferencia uso light vs heavy de AI.
  - **Recomendación v1: `per-month-recoveries` con AI-mode.** Mapea directo al valor que el operador percibe. Desacopla nuestro pricing del price card de Anthropic.

### Sección D — Candidatos a métrica de valor (análisis cross-cutting)

Las mismas 3 métricas candidatas surgen a través de los tiers. Esta sección analiza los pros / contras de cada una y qué señala al comprador.

#### Candidato 1 — `per-seat`

- **Pros:** predecible, familiar (todo SaaS lo hace), fácil de pronosticar para el comprador, escala natural con la adopción del equipo.
- **Contras:** desacopla costo de valor (un equipo de 10 seats que recupera 5 incidentes/semana paga lo mismo que uno de 10 seats que recupera 500/semana). Capa el upside en usuarios heavy.
- **Qué señala:** "cobramos por acceso a la plataforma."
- **Mejor fit:** capa base de Team Cloud + Business.

#### Candidato 2 — `per-recovered-run`

- **Pros:** mapea directo a la métrica maestra (MTTR para automatizaciones fallidas). Alinea precio con valor. La historia se escribe sola: "cobramos cuando te ahorramos toil."
- **Contras:** los compradores no pueden predecir la cuenta hasta saber su volumen de fallas — y "no sabemos nuestro volumen de fallas todavía" es un estado común del comprador. Cuentas variables ponen nervioso a procurement.
- **Qué señala:** "cobramos por outcomes, no por acceso."
- **Mejor fit:** mid-tier Business (combinado con `per-seat`) y Enterprise (combinado con licencia de plataforma).

#### Candidato 3 — `per-AI-call`

- **Pros:** mapea el costo AI al valor AI. El comprador paga por los features AI que usa.
- **Contras:** ata nuestro pricing a la volatilidad del price card de Anthropic. Anima a los compradores a evitar features AI. Lee granular y confuso.
- **Qué señala:** "cobramos por compute AI."
- **Mejor fit:** el add-on AI Recovery Pack (donde el uso AI ES el producto) — pero expresado como "`per-month-recoveries-with-AI-mode`" en lugar de `per-call` crudo, para desacoplar del precio del token.

#### Matriz de recomendación (qué métrica encaja en qué tier)

| Tier | Métrica de valor recomendada |
| --- | --- |
| Developer / Self-host | Free; sin métrica. |
| Team Cloud | `per-seat` con runs bundled allowance. |
| Business | `per-seat` con allowance de roles custom + bandas de volumen de recovery. |
| Enterprise | Licencia de plataforma anual + banda de seats. |
| AI Recovery Pack (add-on) | `per-month-recoveries` con tag AI-mode. |

#### Qué evitamos explícitamente

- **Pricing `per-connector`.** El modelo de Zapier. Cuña equivocada — no estamos vendiendo conteo de integraciones.
- **Pricing `per-workflow-step`.** Demasiado granular para que los compradores predigan. Engineers construyendo DAGs van a resentir la métrica.
- **Pricing `per-LLM-token`.** Ata nuestro pricing al price card del provider de LLM. Si Anthropic dobla su precio per-token de la noche a la mañana, nuestro pricing se rompe.
- **Tier free con output watermarked / branded.** Abarata la marca por un lift de conversión chico.
- **Pricing "Enterprise" en la página pública.** Enterprise es "contact us" por definición; publicar un número ancla mal la negociación.

### Sección E — Mapa tier → segmento (cheat sheet de ventas)

Para ventas: cuando un lead inbound tiene segmento identificado (vía el persona-to-segment table de `icp.md`), esta tabla mapea al tier recomendado + si vale upsell del AI Recovery Pack.

| Segmento ICP | Tier recomendado | ¿Upsell del AI Recovery Pack? |
| --- | --- | --- |
| **B2B startups with ops workflows** (Segmento 1) | Team Cloud → Business cuando el equipo crece | Sí — el loop de recuperación de refund/billing se beneficia más de las patch suggestions AI |
| **Engineering/support teams** (Segmento 2) | Business | Sí — el triage de incidentes se beneficia de la explicación AI y el clustering de patrones |
| **AI builders/agencies** (Segmento 3) | Developer/Self-host para su propio org + Business para deployments de cliente | Mixto — los AI builders frecuentemente tienen sus propias keys de LLM para trabajo de cliente; ofrece el add-on, acepta "no" con elegancia |

### Sección F — Controles enterprise a profundidad

Nombrado explícitamente en el AC. Cada control lleva un tag de honestidad: `(en producción)`, `(roadmap)`, `(objetivo de empaquetado)`, o `(caso a caso)`.

- **SSO vía WorkOS** — SAML, OIDC, enforced-SSO por org. `(en producción — ver sección de auth en AGENTS.md: flujo SSO WorkOS con state firmado por HMAC, protección de replay vía sso_state_nonces, membership JIT vía verified_domains / invitations / sso_connections.)`
- **SCIM vía WorkOS Directory Sync** — `(en producción — 4 tablas: scim_directories / scim_user_state / scim_group_state / scim_processed_events; verificación de firma de webhook vía HMAC estilo Stripe; 3 guards de idempotencia (replay, out-of-order, resurrection).)`
- **Ventanas custom de retención de auditoría** — más allá de la retención por defecto en `audit_logs` / `run_events` / `usage_events`. `(roadmap; PLAN §11 sigue tracking soft delete + ventanas de retención como inacabado.)`
- **Ambientes dedicados aislados** — deployment managed cloud single-tenant (Postgres + Redis + worker + API separados por cliente Enterprise). `(objetivo de empaquetado; playbook de deployment y SLA siguen contract-scoped hasta productionizarse.)`
- **VPC peering privado** — para clientes que requieren aislamiento a nivel de red entre su infraestructura y el managed cloud de Janusly. `(item de roadmap — disponible caso a caso para design partners hasta productionizarse; no prometer en la landing page.)`
- **Soporte de cuenta nombrada + technical account manager (TAM)** — un humano nombrado asignado a la relación al firmar contrato. `(caso a caso; la persona nombrada es dueña de la relación a través de los renovales y es el path de escalation para issues de producción.)`
- **Security review con POC nombrado** — cada cliente Enterprise obtiene un contacto de seguridad nombrado del lado Janusly para vendor security questionnaires, incidentes de seguridad y responses de auditoría. `(caso a caso; el turnaround del vendor-questionnaire se mide como SLA.)`

### Sección G — Plan de release de pricing

¿Cuándo publicamos números reales? Atado al cierre de ENG-093.

- **Hoy (ENG-068 sale, sin números).** Las conversaciones de venta responden "¿cuánto?" con `"trabajaremos con tu equipo sobre el precio una vez que ambos conozcamos el workload"`. El fit de segmento del discovery call + volumen de runs estimado de `icp.md` es el input que nos deja nombrar un tier; el precio dentro de ese tier se negocia.
- **Después de que ENG-093 cierre.** La data de MTTR de la beta privada + las señales de willingness-to-pay de los 3 design partners ajustan las bandas candidatas de `per-seat` y `per-recovered-run`. Elegimos el número v1 para Team Cloud + Business y publicamos en la página de pricing.
- **Después de tener 10+ clientes pagando en Team Cloud.** Tenemos data de variancia suficiente para publicar un `per-seat` público para Team Cloud + Business con confianza. Enterprise se queda en "contact us" indefinidamente.
- **Qué nunca publicamos público-facing.** Números de metering per-incident (negociados por contrato), costos unitarios de AI-call (atados a volatilidad del price card del provider), mínimos Enterprise (anclan mal las negociaciones).

### Sección H — Lo que NO está en este doc

La lista explícita de out-of-scope. Tickets que tomen cualquiera de estos son separados.

- **Sin montos en dólares.** Per el AC ("sin sobre-complicar las ventas tempranas" + "sin implementación de billing requerida"); ENG-093 ajusta los números reales. Las conversaciones de venta nombran "tier" + "candidato a métrica de valor", no "$X / seat / mes".
- **Sin implementación de Stripe / billing.** Dep baneada per `AGENTS.md`. ENG-068 es docs only. La implementación eventual de billing va a elegir Lago, un flujo de facturación hand-rolled, u otra opción no-Stripe.
- **Sin flujo de checkout / wiring de signup-to-billing.** Ticket futuro una vez que se elija un provider de billing.
- **Sin política de descuento, sin markup annual-vs-monthly, sin programa de referidos.** Territorio de pricing-operations; pertenece a un ticket follow-up una vez que los números v1 estén seteados.
- **Sin EULA / templates de contrato / Master Services Agreement.** El equipo legal es dueño de esos.
- **Sin localización UI de la página de pricing in-product.** La landing page en sí es bilingüe (ENG-066); la localización de la página de pricing in-product pasa cuando esa página se construya. Este doc SÍ es bilingüe (es lo que estás leyendo); la superficie in-product es separada.
- **Sin pricing per-región.** Las regiones son un tema de deployment Enterprise, no un tema de tier. Manejado por contrato Enterprise.

### Sección I — Tabla comparativa

Tabla única scan-friendly. Útil como referencia at-a-glance para la futura landing page de pricing.

| Feature | Developer / Self-host | Team Cloud | Business | Enterprise |
| --- | --- | --- | --- | --- |
| Runtime de flujos (Postgres + BullMQ) | ✓ (self-hosted) | ✓ (managed) | ✓ (managed) | ✓ (managed) |
| Centro de Recuperación (DLQ, failure clusters, validación en sandbox, rollback de versión) | ✓ | ✓ | ✓ | ✓ |
| Editor DAG (canvas React Flow) | ✓ | ✓ | ✓ | ✓ |
| Tools de integración (Slack, GitHub, email, webhook) | ✓ | ✓ | ✓ | ✓ |
| Cliente + server MCP | ✓ | ✓ | ✓ | ✓ |
| Cliente LLM (bring-your-own-key en self-host) | ✓ (BYO key) | ✓ (BYO o managed) | ✓ (BYO o managed) | ✓ (BYO o managed) |
| Audit log + trazas OpenTelemetry | ✓ | ✓ | ✓ | ✓ |
| Org compartido con aislamiento de tenant cross-team | — | ✓ | ✓ | ✓ |
| Mailer managed + object store | — | ✓ | ✓ | ✓ |
| SLA de uptime | — | básico | upgraded | SLA nombrado en contrato |
| Billing central | — | ✓ | ✓ | ✓ |
| Roles custom RBAC + overrides de permisos | — | — | ✓ | ✓ |
| Governance de presupuesto + budget gating por flujo | — | — | ✓ | ✓ |
| Analytics del feedback de recuperación + dashboards de Failure Cluster | — | — | ✓ | ✓ |
| Reporting de costo + uso | — | — | ✓ | ✓ |
| SSO (SAML / OIDC vía WorkOS) | — | — | — | ✓ `(en producción)` |
| SCIM Directory Sync | — | — | — | ✓ `(en producción)` |
| Ambientes dedicados aislados | — | — | — | `(objetivo de empaquetado; contract-scoped)` |
| Ventanas custom de retención de auditoría | — | — | — | `(roadmap)` |
| VPC peering privado | — | — | — | `(roadmap)` |
| TAM nombrado + POC de seguridad | — | — | — | ✓ |
| **AI Recovery Pack (add-on managed)** | — `(BYO key en self-host; sin model spend managed)` | disponible como add-on | disponible como add-on | disponible como add-on |

**`—` = no incluido.** **`✓` = incluido.** **Los tags `(en producción)` / `(roadmap)` son los marcadores de honestidad** para cosas en la frontera de engineering.

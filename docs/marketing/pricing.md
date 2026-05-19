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
- **No Spanish translation.** The landing page is bilingual (ENG-066); the pricing page localization happens when the page is built. `pricing.md` stays English-only as the sales-team source of truth.
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

**Empty cell = not included.** **`✓` = included.** **`(shipped)` / `(roadmap)` tags are the honesty markers** for things at the engineering boundary.

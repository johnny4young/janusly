# Janusly competitive positioning packet

The single sales-ready document for "how do you compare against X?" — open this tab before any call where the buyer mentioned a competitor by name, then pre-load the recommended demo before you dial in.

**Strategy lives in [`docs/PLAN.md` §16.0](../PLAN.md).** **Brand voice in [`docs/marketing/narrative.md`](narrative.md).** **Segment definitions in [`docs/marketing/icp.md`](icp.md).** **Packaging structure in [`docs/marketing/pricing.md`](pricing.md).** This doc consumes all four and is the **anti-positioning layer** — it names competitors by name, says where each is stronger, says where Janusly is stronger, and says where we will not even try to compete. Every "where Janusly is stronger" claim cites a shipped route, table, or AGENTS.md invariant inline. Roadmap items get an explicit `(roadmap)` tag.

---

## Section A — How to use this doc

Two consumers, two reading paths.

- **For sales.** Scan **Section F** (per-competitor block) before any call where the buyer mentioned competitor X by name. Pre-load the recommended demo from **Section G**. Use the objection-handling lines in F verbatim — do not extemporize against competitors during a live call.
- **For founders.** **Section C** (comparison table) is the slide. **Section H** (anti-positioning principle restated) is the closing line of the sales deck.

**Voice rules from [`narrative.md`](narrative.md) apply.** Anti-positioning is not snark — it is respect for the buyer's time. We never name what is *wrong* with the competition in customer-facing copy. We name what we are FOR, and we name what we are NOT. This internal doc is the one place a competitor's name appears next to an analytical sentence.

**Honesty tags.** Every "where Janusly is stronger" claim is anchored in a shipped route or feature, cited inline. Capabilities still in flight carry a `(roadmap)` tag — sales never over-promises. Where a competitor's capability is fast-moving or ambiguous, the comparison table uses `partial` rather than `✓` and a footnote names the qualifier.

---

## Section B — The anti-positioning principle

Recovery, not integration breadth, is the wedge. The line from PLAN §16.0 carries verbatim:

> Zapier wins on integration count; Janusly wins on what happens when an automation fails in production.

That sentence is the whole position. Everything below cashes it out per competitor.

**What we never claim.** "More integrations than Zapier." "Easier than Zapier." "Cheaper than Make." "More flexible than n8n." All four are races we lose by design.

**What we always claim.** Observable runs, explained failures, reviewable patches, replayable runs, MTTR as the metric of record.

**What we never put in customer-facing copy.** "Better than [competitor]." That phrasing is reserved for this internal doc. In a deck, a landing page, a sales email, on a podcast — we name what we ARE FOR (observable, explainable, reviewable, replayable) and what we ARE NOT (better Zapier UI, n8n with AI, generic RPA, agents that do everything). The buyer infers the rest. That is the position.

---

## Section C — Comparison table

The slide-friendly grid. Rows are the dimensions of an AI workflow platform; columns are the seven competitors named in this packet plus Janusly. Cells use `✓` (shipped, first-class), `partial` (present but with qualifiers — see footnote), `—` (not present), and `N` ("not their focus by design," used where the dimension is intentionally not a competitor's bet). Where Janusly carries `N`, we cede that dimension on purpose — see Section D.

| Dimension | Zapier | Make | n8n | Workato | Pipedream | Relay | Gumloop | Janusly |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Observable DAG runtime | partial¹ | partial¹ | ✓ | ✓ | ✓ | partial¹ | partial¹ | ✓ |
| AI-explained failures | — | — | — | — | — | — | — | ✓ |
| AI patch suggestions (per-node, confidence-scored) | — | — | — | — | — | — | — | ✓ |
| Sandbox replay before save | — | — | — | partial² | — | — | — | ✓ |
| Version rollback (one click) | partial³ | partial³ | partial³ | ✓ | partial³ | — | — | ✓ |
| Failure-signature clustering | — | — | — | — | — | — | — | ✓ |
| MTTR as a first-class metric | — | — | — | — | — | — | — | ✓ |
| Self-host (full runtime) | — | — | ✓ | — | partial⁴ | — | — | ✓ |
| SSO + SCIM (enterprise auth) | ✓ | ✓ | partial⁵ | ✓ | ✓ | partial⁵ | partial⁵ | ✓ |
| MCP client + server | — | — | partial⁶ | — | partial⁶ | partial⁶ | — | ✓ |
| Multi-tenant engine-level scope | partial⁷ | partial⁷ | partial⁷ | ✓ | partial⁷ | — | — | ✓ |
| Audit log per action | partial⁸ | partial⁸ | partial⁸ | ✓ | partial⁸ | — | — | ✓ |
| Integration catalog size | ✓ (thousands) | ✓ (thousands) | partial (hundreds) | ✓ (thousands, enterprise) | ✓ (thousands) | partial (curated) | partial (curated) | N |
| No-code primary surface | ✓ | ✓ | partial⁹ | ✓ | — | ✓ | ✓ | N |
| Code-first primary surface | — | — | ✓ | partial¹⁰ | ✓ | — | — | partial¹¹ |
| AI-native vs AI-bolted-on | bolted-on | bolted-on | bolted-on | assistant-on-top | bolted-on | AI-native | AI-native | AI-native |

**Footnotes (the qualifier is the point):**

1. Visual scenario / step view exists, but is not a DAG with structured run events, lifecycle transitions, or OTel traces tagged `service.name="janusly"` end-to-end.
2. Workato has recipe-test capabilities; not an automated "save only if a writes-skipped replay succeeded" gate the way `POST /dlq/validate-fix` operates against the persisted run.
3. Editing history exists; "rollback to version N-1 in one click as a single transaction with `workflow.rolled_back` audit" — Janusly's `POST /workflows/rollback` shape — is not the same operation.
4. Self-host options vary by tier and are not full-runtime in the free tier.
5. SSO support varies by plan; SCIM Directory Sync typically gated to enterprise tiers or absent. Janusly ships both via WorkOS today (per AGENTS.md auth section).
6. MCP-related capability via community nodes, integrations, or roadmap items, not a first-class node type with two-flag write consent + dry-run gating + Redis-backed rate-limit buckets the way Janusly's `mcp_tool` operates.
7. Per-account / per-workspace isolation exists at the application layer; "engine-level multi-tenant scope enforced on every query via `eq(<table>.orgId, auth.orgId)`" — Janusly's posture per AGENTS.md — is not the same architectural commitment.
8. Some logging / activity history exists; "audit row per AI action, per recovery action, per membership change, per config change" with the closed catalog Janusly maintains is not the same.
9. n8n has a visual editor + the JS code node; for any non-trivial flow the code node usually shows up.
10. Workato has a recipe DSL but the typical surface is a guided visual builder.
11. Janusly's primary surface is the visual DAG editor + Inspector. The DSL is Zod-typed JSON; operators usually do not hand-write it.

**Honesty note on the integration-count row.** Zapier, Make, Workato, and Pipedream all maintain larger raw catalogs than Janusly will, by design. The table reads as fair so the rows where Janusly wins read as credible. See Section D for the explicit list of what we cede.

---

## Section D — Where Janusly intentionally does not compete

The "we lose on purpose" list. Knowing the boundary is part of the position.

- **Integration catalog count.** Zapier, Make, Workato, and Pipedream all have larger raw catalogs and will for the foreseeable future. We pick a small set of recovery-relevant integrations (Slack, GitHub, email, signed webhook, MCP client + server) per PLAN §16.5. If a buyer's primary need is "connect 50 SaaS apps that already work," recommend they keep Zapier or Make for that surface.
- **No-code, non-technical-user-friendly UX.** Zapier wins on "my marketing manager built this in 10 minutes." Janusly is for the technical builder and the ops lead who actually wants to read the audit log. If a buyer's primary user is a non-technical employee building one-off automations, recommend Zapier or Gumloop.
- **Cheapest hosted no-code entry point.** Zapier's free tier is optimized for the buyer who wants the cheapest hosted way to connect a few SaaS apps. We do not price on per-task volume — see [`pricing.md`](pricing.md) for the value-metric posture. If "cheapest possible hosted automation" is the buying criterion, this is not a fit.
- **Largest community / template marketplace.** n8n and Zapier have years of head-start in crowd-sourced templates. Janusly ships 7 canonical demos under [`docs/demos/`](../demos/) curated intentionally; we are not racing to a million community templates.
- **Air-gapped on-prem deployment.** Out of scope for v1 (named explicitly in [`icp.md`](icp.md) Stage 2 disqualification triggers). Workato wins this category for compliance-heavy enterprises that mandate air-gap.

A "polite no" on any of the above is the correct sales answer. Disqualifying a wrong-segment buyer fast respects their time and ours.

---

## Section E — Buying triggers

The moments a buyer leaves a competitor and pivots toward Janusly. Each trigger lists the engineering reality that meets the moment plus the demo to lead with.

- **Trigger 1: "Our automation broke at 3am and we couldn't figure out why."** — Recovery Center (`RecoveryCenterPanel.tsx`) + `POST /ai/explain-run` produces a plain-English root cause grounded in `run_events`. Demo: [failed-workflow-recovery](../demos/failed-workflow-recovery.md).
- **Trigger 2: "We need an audit log per AI action for compliance."** — multi-tenant scope on every query (`eq(<table>.orgId, auth.orgId)`) + `audit_logs` per action + `workflow_versions` rollback. Demo: [failed-workflow-recovery](../demos/failed-workflow-recovery.md) + [incident-triage](../demos/incident-triage.md).
- **Trigger 3: "Our agent demo works but production keeps breaking."** — recovery layer + `POST /dlq/validate-fix` sandbox replay (writes-skipped gate) + `POST /ai/patch-workflow` with confidence-scored alternatives. Demo: [multi-agent-decision](../demos/multi-agent-decision.md) + [failed-workflow-recovery](../demos/failed-workflow-recovery.md).
- **Trigger 4: "We tried n8n's error workflows; they don't explain anything."** — `POST /ai/patch-workflow` returns 1–3 alternatives with `confidence` (0–100) and `approachLabel` (`add_retry` / `raise_timeout` / `swap_secret_ref` / `add_approval` / `fix_url` / `other`). Demo: [failed-workflow-recovery](../demos/failed-workflow-recovery.md).
- **Trigger 5: "We're hitting AI cost surprises on our workflows."** — budget governance via `GET /billing/budget` + per-org / per-workflow caps in `org_configs.ai.budget*` + `workflow_budgets` + AI Studio cost preview chips from `@janusly/shared/src/llm-pricing`. Demo: [failed-workflow-recovery](../demos/failed-workflow-recovery.md) (Operations dashboard tour).
- **Trigger 6: "Our agency rewrites the same recovery glue per client."** — Janusly IS the recovery glue: DLQ + structured `errorJson` + sandbox replay + version rollback + audit per action + MCP client. Demo: [multi-agent-decision](../demos/multi-agent-decision.md) + [mcp-notion-summary](../demos/mcp-notion-summary.md).
- **Trigger 7: "Compliance asked who approved this AI action."** — `audit_logs` per action + RBAC custom roles via per-org `org_roles` (17-key permission catalog) + SSO via WorkOS `(shipped)` + SCIM Directory Sync `(shipped)`. Demo: [incident-triage](../demos/incident-triage.md).

If a trigger is what the buyer just said out loud, jump to the matching demo. If two triggers fit, the buyer is segment-fit — use the persona-to-segment table at the bottom of [`icp.md`](icp.md) to pick which talk track to bring.

---

## Section F — Per-competitor sub-blocks

One block per AC competitor; seven blocks total. Every block follows the same shape so a seller can pattern-match in 30 seconds before a call.

### F.1 — Zapier

> One-line read: the integration-catalog leader and the no-code-first SMB brand. Massive catalog, marketing-manager-friendly UX, generous free tier.

**Where they're stronger.** Catalog size (thousands of connectors). No-code UX optimized for non-engineers. Brand trust at the SMB / single-marketer end. Free-tier price. Years of community-contributed templates. AI features ("Zapier AI Actions," "Zapier Agents") added on top of the integration runtime.

**Where Janusly is stronger.** Recovery Center as the authenticated home (`RecoveryCenterPanel.tsx`). Sandbox replay before save (`POST /dlq/validate-fix`). `audit_logs` per action. `workflow_versions` with one-click rollback (`POST /workflows/rollback`). Multi-tenant scope enforced engine-level (`eq(<table>.orgId, auth.orgId)` on every query per AGENTS.md). AI as part of the runtime — the `ai` + `agent` + `multi_agent` + `router_llm` node types are first-class, not assistant features.

**Choose Zapier when.** The team's question is "how many SaaS apps can I connect in 10 minutes?" — and audit / recovery / version rollback are not priorities yet. A non-technical primary user. A budget that needs the cheapest possible bottom tier.

**Objection-handling lines (lift from [`icp.md`](icp.md)).**

- "I already have Zapier." → *"Zapier is great when your question is 'how do I connect SaaS apps that already work?' We're the layer you reach for when one of those apps fails — Zapier doesn't help you when Stripe returns a 401 or your billing API rotates a credential. Try our recovery demo for two minutes; you'll see the difference immediately."*
- "Zapier is cheaper." → *"At the SMB free tier, yes — and if cheapest-possible is the criterion, Zapier is the right answer. We price for teams running workflows where 'cheapest' is no longer the question; 'auditable, recoverable, rollback-able' is."*

**Recommended demo.** [failed-workflow-recovery](../demos/failed-workflow-recovery.md). Close the gap immediately on the recovery wedge — the demo runs both a missing-secret and a write-side-without-approval failure end-to-end in 4 minutes.

---

### F.2 — Make (formerly Integromat)

> One-line read: Zapier with a developer-friendlier UX, branching scenarios, iterators, and error-handler routes. Stronger dev ergonomics than Zapier without the code-step depth of Pipedream or n8n.

**Where they're stronger.** Visual scenario editor with branching + iterators. Error-handler routes as a core pattern ("on error, do X"). Dev-friendly compared to Zapier — operators can read the JSON shape of every step. Large catalog (thousands of apps).

**Where Janusly is stronger.** AI patch suggestions with confidence scores (`POST /ai/patch-workflow` returns 1–3 alternatives with `approachLabel` + `confidence` 0–100) versus raw error handlers that just route to a fallback step. Failure-signature clustering (`packages/shared/src/error-signature.ts` + `GET /dlq/clusters` group repeated failures so the operator sees "47 workflows failed for the same reason" rather than 47 rows). MCP client as a first-class node type. MTTR rollup (`GET /recovery/metrics`).

**Choose Make when.** The team wants a more dev-friendly Zapier-shape product and AI-native workflows are not in scope. The error path's "route to a handler step" pattern is sufficient and the team is not asking the AI to explain or repair the failure.

**Objection-handling lines.**

- "Make has error-handler routes." → *"Error handlers route the run to a fallback path you wrote ahead of time. Janusly's recovery dialog reads the failure, proposes 1-3 patches with a confidence score per option, validates the patch in a sandbox without touching the real system, and saves a new version with one click. Different shape."*
- "We like Make's scenario UX." → *"Keep it for the simple scenarios. Recovery is a separate question — when do you want AI in the loop on the fix, audit per action, and version rollback as a core capability? That's where we are."*

**Recommended demo.** [failed-workflow-recovery](../demos/failed-workflow-recovery.md).

---

### F.3 — n8n

> One-line read: self-host-friendly fair-code workflow engine with JS code nodes, large community, error workflows. The default choice for technical builders who want self-host and DIY flexibility.

**Where they're stronger.** Fair-code license (Sustainable Use License). JS code nodes directly in the workflow. Large self-host community and community-template marketplace. Error workflows as a built-in pattern. Recent AI / LangChain node additions broaden the AI surface significantly (the table marks this as `partial` because it is real but bolted onto the existing engine rather than AI-native).

**Where Janusly is stronger.** Recovery loop as a first-class surface — Recovery Center home (`RecoveryCenterPanel.tsx`) + DLQ + failure-signature clustering — versus error-workflow-as-a-pattern. AI patch suggestions with `confidence` + `approachLabel` versus a code-node "do something on error." Version rollback as a core capability (`POST /workflows/rollback` writes a `workflow.rolled_back` audit row in a single transaction). MCP client AND server (`packages/mcp-server` exposes 15 read-only tools + a gated `workflows.save` write surface). OTel `service.name="janusly"` end-to-end across api + worker + engine.

**Choose n8n when.** The team wants to write JS directly in workflow nodes and is comfortable owning the runtime. The team has already standardized on n8n and the cost-to-migrate is high. Fair-code self-host is a hard requirement.

**Objection-handling lines.**

- "We already self-host n8n." → *"Keep it for the workflows you've already wired. The wedge is what happens when one of those workflows breaks — the AI-explained failure, the patch with a confidence score, the sandbox validation before save, the one-click version rollback. That's the recovery layer your error workflows don't cover."*
- "n8n has AI nodes now." → *"They do — and the nodes work. The architectural difference is where AI lives: their AI nodes are workflow steps; ours is the engine. `POST /ai/patch-workflow` and `POST /ai/explain-run` and `POST /ai/review-workflow` are part of the runtime, not nodes you wire by hand. Different commitment."*

**Recommended demo.** [failed-workflow-recovery](../demos/failed-workflow-recovery.md) + [multi-agent-decision](../demos/multi-agent-decision.md) (technical-builder follow-up).

---

### F.4 — Workato

> One-line read: enterprise iPaaS leader with the deepest connector library and the RecipeIQ AI assistant. Enterprise sales motion, enterprise pricing, enterprise governance.

**Where they're stronger.** Large enterprise connector catalog. Large-enterprise sales motion and procurement track record. Deep governance, role-based access, multi-environment posture. RecipeIQ AI assistant for recipe creation. On-prem deployment options for compliance-heavy customers (Janusly cedes this — see Section D).

**Where Janusly is stronger.** AI as part of the engine, not an assistant layer — `POST /ai/generate-workflow` (Anthropic-backed grammar), `POST /ai/patch-workflow` (per-node-type config envelopes + the structural `insert_approval_upstream` envelope from AGENTS.md), the first-class `ai` + `agent` + `multi_agent` + `router_llm` + `agent_reflection` node types. Sandbox replay before save (`POST /dlq/validate-fix` runs a writes-skipped replay through the same engine and only gates the save when the sandbox terminates `succeeded`). Failure-signature clustering. MTTR as the metric of record. Much simpler pricing posture (see [`pricing.md`](pricing.md) — we do not lead with a 6-figure enterprise minimum).

**Choose Workato when.** A Fortune 500 with 50+ enterprise SaaS systems and a multi-million-dollar IT budget. Air-gapped on-prem deployment is a hard requirement. The buyer is an enterprise architect, not a builder.

**Objection-handling lines.**

- "Workato has RecipeIQ." → *"RecipeIQ helps you write the recipe faster — it sits on top of the runtime. We're a different layer: when the recipe runs in production and breaks, our AI reads the failure, proposes patches with confidence scores, validates in a sandbox before save. Complementary to recipe authoring, not a replacement for it."*
- "Workato is the enterprise standard." → *"It is — and we're not trying to compete on connector count. The wedge is recovery and operational trust for the AI-driven part of your workflow portfolio. If the buyer's pain is 'our AI workflows break and we can't operate them,' that's our category."*

**Recommended demo.** [incident-triage](../demos/incident-triage.md) — the engineering-buyer demo lands cleaner here than the refund-triage SMB story.

---

### F.5 — Pipedream

> One-line read: code-first event-driven serverless workflow runner. Node.js / Python / Go / Bash code steps as the primary unit. Generous free tier, large event-source library, developer-centric brand.

**Where they're stronger.** Code-step ergonomics across Node / Python / Go / Bash. Event-source library tied to webhook patterns for SaaS systems. Generous free tier for solo devs and indie builders. Recent AI feature additions broaden the AI surface (table marks this as `partial`).

**Where Janusly is stronger.** Recovery Center versus raw retry config — the operator surface for "what happened, why, and what to do next" is a built product, not a logs view. AI-explained failures (`POST /ai/explain-run` produces a plain-English root cause grounded in `run_events`). Sandbox replay before save. `audit_logs` per action with the multi-tenant scope invariant. Multi-tenant engine-level scope (`eq(<table>.orgId, auth.orgId)` on every query) for B2B sales where one customer's data must not leak across tenants.

**Choose Pipedream when.** The buyer is an indie dev with no compliance need and wants maximum code flexibility. The primary workload is event-source → code-step → API call patterns and "what if it breaks" is a developer-self-service problem.

**Objection-handling lines.**

- "Pipedream is faster for code-step workflows." → *"For pure code-step flows, yes — they're optimized for it. The question is operating the flow after handoff: who reads the audit log, who reviews the patch when something breaks, who proves the fix worked before save. Different problem."*
- "Pipedream has a generous free tier." → *"Right answer for an indie dev. Once the workflow is running customer-facing work and 'who approved this AI action' becomes a real question, the tier is the wrong axis to optimize."*

**Recommended demo.** [multi-agent-decision](../demos/multi-agent-decision.md) — the technical-AI-buyer demo plays well to a code-first audience and shows the multi-agent capability Pipedream does not have as a first-class concept.

---

### F.6 — Relay

> One-line read: AI-native workflow tool with a clean UX and a human-in-the-loop emphasis. Younger product, smaller integration set, focused on the AI-first workflow shape.

**Where they're stronger.** Clean AI-first builder UX. Human-approval emphasis lands well with buyers worried about AI autonomy. Younger product means fewer legacy decisions to defend.

**Where Janusly is stronger.** Observable DAG runtime grounded in `run_events` + OTel `service.name="janusly"` end-to-end. Recovery Center as the home screen. Sandbox replay (`POST /dlq/validate-fix`). `workflow_versions` rollback. MCP client + server. Audit log per action. Failure-signature clustering. Same fundamental product shape with a substantially deeper operator surface and the engineering invariants documented in AGENTS.md. Multi-tenant engine-level scope as a foundational commitment, not a roadmap line.

**Choose Relay when.** The buyer wants the simplest possible AI-workflow surface and does not need the recovery / audit / replay depth. Their workflows are net-new AI-first; they are not migrating from a heavier existing platform.

**Objection-handling lines.**

- "Relay's UX is cleaner." → *"For a simple AI-first workflow, it is. The question is what the surface looks like the day after the workflow goes to production: when a step fails, what does the recovery dialog show, what's in the audit log, can you roll back a version. That's where the depth shows up."*
- "Relay also has human approval." → *"Right — human approval as a node is table stakes for our category. Where we go further is the recovery dialog: AI proposes 1-3 patches with confidence scores, sandbox validates before save, version saves with a `workflow.rolled_back` audit row available for one-click rollback. Same human-in-the-loop principle, more surface."*

**Recommended demo.** [failed-workflow-recovery](../demos/failed-workflow-recovery.md) — show the operator-surface depth that the smaller product cannot reproduce yet.

---

### F.7 — Gumloop

> One-line read: drag-and-drop AI workflow builder for non-engineers. Simplest AI builder UX, fast time-to-first-workflow, non-technical primary user.

**Where they're stronger.** Simplest AI builder UX in the category. Fastest time-to-first-AI-workflow for a non-engineer. Marketing-team-friendly, "I built this in an afternoon" buying motion.

**Where Janusly is stronger.** Recovery Center as the home screen. Sandbox replay before save. MTTR rollup (`GET /recovery/metrics`) as the master metric. `audit_logs` per action. RBAC via per-org `org_roles` with the 17-key permission catalog. SSO via WorkOS `(shipped)` and SCIM Directory Sync `(shipped)`. We are for the operator who lives with the workflow in production; Gumloop is for the prototyper.

**Choose Gumloop when.** The team is non-technical and the buying criterion is "AI workflow demo by Friday." The workflow is one-off, low-stakes, not customer-facing. Audit / recovery / RBAC are not on the buyer's list.

**Objection-handling lines.**

- "Gumloop is easier to start with." → *"Right — for the first workflow on day one. The question shifts on day 30: who reads the audit log when finance asks, who reviews the patch when it breaks, can you roll back to last week's version. That's our category."*
- "We don't have engineers." → *"Then you're not segment-fit for us today — and that's an honest answer. We're for the technical builder + the ops lead. If you don't have either role on the team, Gumloop is a better fit."*

**Recommended demo.** [failed-workflow-recovery](../demos/failed-workflow-recovery.md) + [incident-triage](../demos/incident-triage.md) — show both the recovery loop AND the operator-surface depth, then ask whether the buyer has someone on the team who would actually use it.

---

## Section G — Demo mapping

The "buyer mentioned competitor X, pre-load demo Y" cheat sheet. Use this table to set up the call agenda before you dial in. Demo filenames are verbatim from [`docs/demos/`](../demos/).

| Buyer mentioned | Lead with | Follow-up demo | Canonical segment from [`icp.md`](icp.md) |
| --- | --- | --- | --- |
| Zapier | [failed-workflow-recovery](../demos/failed-workflow-recovery.md) | [refund-triage](../demos/refund-triage.md) | B2B startups with ops workflows |
| Make (Integromat) | [failed-workflow-recovery](../demos/failed-workflow-recovery.md) | [refund-triage](../demos/refund-triage.md) | B2B startups with ops workflows |
| n8n | [failed-workflow-recovery](../demos/failed-workflow-recovery.md) | [multi-agent-decision](../demos/multi-agent-decision.md) | Engineering/support teams |
| Workato | [incident-triage](../demos/incident-triage.md) | [failed-workflow-recovery](../demos/failed-workflow-recovery.md) | Engineering/support teams |
| Pipedream | [multi-agent-decision](../demos/multi-agent-decision.md) | [failed-workflow-recovery](../demos/failed-workflow-recovery.md) | AI builders/agencies |
| Relay | [failed-workflow-recovery](../demos/failed-workflow-recovery.md) | [multi-agent-decision](../demos/multi-agent-decision.md) | AI builders/agencies |
| Gumloop | [failed-workflow-recovery](../demos/failed-workflow-recovery.md) | [incident-triage](../demos/incident-triage.md) | Disqualify first; if segment-fit → B2B startups with ops workflows |

After picking the demo, confirm segment fit against the persona-to-segment table at the bottom of [`icp.md`](icp.md). If the persona on the call does not appear in that table, segment-fit is the first conversation, not the demo.

---

## Section H — Anti-positioning principle restated

The most credible competitive position is the one that names what you are FOR and lets the buyer infer the rest.

- **We name what we are FOR.** Observable runs. Explained failures. Reviewable patches. Replayable runs.
- **We name what we are NOT.** Not a better Zapier UI. Not n8n with AI. Not generic RPA. Not agents that do everything.
- **We never name what is wrong with the competition by name in customer-facing copy.** That belongs in this internal doc only.

When a competitor's name comes up in a deck, a sales email, a landing page, or a podcast, the line is: *"We're a different category — we're for [our FOR list]. If your question is [their strength], they're a great answer."* Then you move on.

**The metric of record.** MTTR for failed automations. From hours to minutes, from minutes to seconds. Every demo loops back to it; every business-case slide cites it; every private-beta measurement (ENG-093) anchors on it. That is the number we hold ourselves to, and that is the number we ask the buyer to measure us against.

---

## Section I — What's NOT in this doc

The explicit out-of-scope list, so neither sales nor founders accidentally over-load this packet:

- **No dollar amounts.** Pricing comparisons belong to [`pricing.md`](pricing.md). This doc names structural advantage; it does not name price gaps.
- **No live competitive intel.** Competitor product capabilities can shift quickly. The doc names the structural shape of each competitor as of authoring, not specific feature counts that go stale. Footnotes use qualifiers ("thousands of integrations," "the integration leader by catalog size") rather than dated numbers.
- **No public-facing comparison pages.** This is the internal sales doc. `/compare/zapier`, `/compare/n8n`, and similar public landing pages are future web-implementation tickets, not part of this packet.
- **No RFP boilerplate or vendor security questionnaire answers.** Compliance asks for specific answers; those belong to a separate enterprise-sales playbook.
- **No competitive-intel monitoring process.** Watching competitor releases / pricing changes is an operational process owned by founders + sales, not a doc.
- **No Spanish translation.** Same posture as [`pricing.md`](pricing.md): English-only as the sales-team internal source of truth. When the public-facing comparison page lands as a separate web ticket, Spanish localization happens there.

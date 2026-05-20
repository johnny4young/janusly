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
- **No public-facing competitive-comparison page UI localization.** The public `/compare/*` web pages are a separate web-implementation ticket; their localization happens there. This internal sales doc IS bilingual (see the `Versión en español` block below); only the web-page surface is deferred.

---

## Versión en español

La versión paralela en castellano del **paquete de posicionamiento competitivo** de Janusly. Misma estructura, mismas anclas, misma engineering reality. Nombres de competidores (Zapier, Make, n8n, Workato, Pipedream, Relay, Gumloop), nombres de archivos de demo (`failed-workflow-recovery`, `refund-triage`, `incident-triage`, `multi-agent-decision`, `mcp-notion-summary`), rutas (`POST /ai/patch-workflow`, `POST /dlq/validate-fix`, `POST /workflows/rollback`, etc.), tablas (`run_events`, `audit_logs`, `workflow_versions`, etc.), archivos de código (`RecoveryCenterPanel.tsx`, `packages/shared/src/error-signature.ts`), nombres de productos terceros (WorkOS, Anthropic, LangChain, Sustainable Use License, RecipeIQ), node types (`ai` / `agent` / `multi_agent` / `router_llm` / `agent_reflection` / `mcp_tool`), approachLabels (`add_retry` / `raise_timeout` / `swap_secret_ref` / `add_approval` / `fix_url` / `other`), audit-row names (`workflow.rolled_back`) y constantes OTel (`service.name="janusly"`, `eq(<table>.orgId, auth.orgId)`) quedan todos en inglés en ambos idiomas porque son identificadores, no texto traducible. El brand-mark "Janusly" tampoco se traduce.

Vocabulario canónico, lifted de [`narrative.md`](narrative.md) Versión en español: `autoreparable`, `Centro de Recuperación`, `flujo` / `flujo de trabajo`, `operador`. Quedan en inglés como anglicismos técnicos aceptados del nicho: `sandbox`, `rollback`, `DAG`, `MTTR`, `self-host`, `MCP`, `connector`, `marketplace`, `no-code`, `code-first`, `code-step`, `event-source`, `human-in-the-loop`, `table stakes`, `AI-native`, `bolted-on`, `assistant-on-top`, `fair-code`, `error workflows` (término propio de n8n), `recipe` (término propio de Workato), `loop de recuperación`. Tono: `tú` informal, nunca `usted`. Tags de honestidad: `(en producción)` para lo que ya está shipped, `(roadmap)` para planeado, `(objetivo de empaquetado)` para diseño/contrato, `(caso a caso)` para operacional.

**Tokens de la Sección C** (tabla comparativa) quedan literales en ambos idiomas:

- `✓` = de primera clase / en producción.
- `partial` = presente con calificadores — ver nota al pie correspondiente.
- `—` = no presente.
- `N` = no es su foco por diseño — la dimensión no es la apuesta del competidor (o cuando Janusly carga `N`, es lo que cedemos a propósito; ver Sección D).

Los siete competidores (Zapier, Make, n8n, Workato, Pipedream, Relay, Gumloop) son **marcas registradas de terceros**. La versión española los nombra exactamente igual que la inglesa, sin glosario adicional.

### Sección A — Cómo usar este doc

Dos consumidores, dos caminos de lectura.

- **Para ventas.** Escanea la **Sección F** (sub-bloque por competidor) antes de cualquier llamada donde el comprador mencionó al competidor X por nombre. Pre-carga el demo recomendado desde la **Sección G**. Usa las líneas de manejo de objeciones de F al pie de la letra — no improvises contra competidores durante una llamada en vivo.
- **Para fundadores.** La **Sección C** (tabla comparativa) es el slide. La **Sección H** (principio de anti-posicionamiento recapitulado) es la línea de cierre del deck de ventas.

**Las reglas de voz de [`narrative.md`](narrative.md) aplican.** Anti-posicionamiento no es desprecio — es respeto por el tiempo del comprador. Nunca nombramos lo que está *mal* en la competencia en copy customer-facing. Nombramos lo que SOMOS, y nombramos lo que NO SOMOS. Este doc interno es el único lugar donde el nombre de un competidor aparece junto a una oración analítica.

**Tags de honestidad.** Cada afirmación de "dónde Janusly es más fuerte" está anclada en una ruta o feature en producción, citada en línea. Las capacidades que aún están en vuelo cargan un tag `(roadmap)` — ventas nunca sobre-promete. Donde la capacidad de un competidor es ambigua o se mueve rápido, la tabla comparativa usa `partial` en vez de `✓` y una nota al pie nombra el calificador.

### Sección B — El principio de anti-posicionamiento

La recuperación, no la amplitud de integraciones, es la cuña. La línea de PLAN §16.0 se mantiene verbatim:

> Zapier gana en conteo de integraciones; Janusly gana en lo que pasa cuando una automatización falla en producción.

Esa oración es toda la postura. Todo lo de abajo la cobra por competidor.

**Lo que nunca afirmamos.** "Más integraciones que Zapier." "Más fácil que Zapier." "Más barato que Make." "Más flexible que n8n." Las cuatro son carreras que perdemos por diseño.

**Lo que siempre afirmamos.** Runs observables, fallas explicadas, patches revisables, runs reproducibles, MTTR como métrica de registro.

**Lo que nunca ponemos en copy customer-facing.** "Mejor que [competidor]." Esa frase está reservada a este doc interno. En un deck, en una landing page, en un email de ventas, en un podcast — nombramos lo que SOMOS (observable, explicable, revisable, reproducible) y lo que NO SOMOS (mejor UI de Zapier, n8n con AI, RPA genérico, agentes que hacen todo). El comprador infiere el resto. Esa es la postura.

### Sección C — Tabla comparativa

El grid para usar como slide. Las filas son las dimensiones de una plataforma de flujos AI; las columnas son los siete competidores nombrados en este paquete más Janusly. Las celdas usan `✓` (en producción, de primera clase), `partial` (presente con calificadores — ver nota al pie), `—` (no presente), y `N` ("no es su foco por diseño", usado donde la dimensión intencionalmente no es la apuesta del competidor). Donde Janusly carga `N`, cedemos esa dimensión a propósito — ver Sección D.

| Dimensión | Zapier | Make | n8n | Workato | Pipedream | Relay | Gumloop | Janusly |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Runtime DAG observable | partial¹ | partial¹ | ✓ | ✓ | ✓ | partial¹ | partial¹ | ✓ |
| Fallas explicadas por AI | — | — | — | — | — | — | — | ✓ |
| AI patch suggestions (por nodo, con confidence score) | — | — | — | — | — | — | — | ✓ |
| Replay en sandbox antes de save | — | — | — | partial² | — | — | — | ✓ |
| Version rollback (un clic) | partial³ | partial³ | partial³ | ✓ | partial³ | — | — | ✓ |
| Clustering por signature de falla | — | — | — | — | — | — | — | ✓ |
| MTTR como métrica de primera clase | — | — | — | — | — | — | — | ✓ |
| Self-host (full runtime) | — | — | ✓ | — | partial⁴ | — | — | ✓ |
| SSO + SCIM (auth enterprise) | ✓ | ✓ | partial⁵ | ✓ | ✓ | partial⁵ | partial⁵ | ✓ |
| Cliente + server MCP | — | — | partial⁶ | — | partial⁶ | partial⁶ | — | ✓ |
| Scope multi-tenant a nivel de engine | partial⁷ | partial⁷ | partial⁷ | ✓ | partial⁷ | — | — | ✓ |
| Audit log por acción | partial⁸ | partial⁸ | partial⁸ | ✓ | partial⁸ | — | — | ✓ |
| Tamaño del catálogo de integraciones | ✓ (miles) | ✓ (miles) | partial (cientos) | ✓ (miles, enterprise) | ✓ (miles) | partial (curado) | partial (curado) | N |
| Superficie primaria no-code | ✓ | ✓ | partial⁹ | ✓ | — | ✓ | ✓ | N |
| Superficie primaria code-first | — | — | ✓ | partial¹⁰ | ✓ | — | — | partial¹¹ |
| AI-native vs AI-bolted-on | bolted-on | bolted-on | bolted-on | assistant-on-top | bolted-on | AI-native | AI-native | AI-native |

**Notas al pie (el calificador es la cuestión):**

1. Existe vista visual de escenarios / pasos, pero no es un DAG con eventos de run estructurados, transiciones de ciclo de vida, ni trazas OTel etiquetadas con `service.name="janusly"` end-to-end.
2. Workato tiene capacidades de recipe-test; no es un gate automatizado de "save solo si un replay con writes-skipped fue exitoso" como `POST /dlq/validate-fix` opera contra el run persistido.
3. Existe historial de edición; "rollback a la versión N-1 en un clic, como una sola transacción con `workflow.rolled_back` en audit" — la shape de `POST /workflows/rollback` de Janusly — no es la misma operación.
4. Las opciones de self-host varían por tier y no son full-runtime en el tier gratuito.
5. El soporte de SSO varía por plan; SCIM Directory Sync típicamente queda gateado a tiers enterprise o ausente. Janusly entrega ambos vía WorkOS hoy (por la sección de auth de AGENTS.md).
6. Capacidad relacionada con MCP vía nodos community, integraciones, o items de roadmap — no un node type de primera clase con write consent de dos flags + dry-run gating + buckets de rate-limit en Redis como opera el `mcp_tool` de Janusly.
7. Aislamiento per-account / per-workspace existe a nivel de aplicación; "scope multi-tenant a nivel de engine enforced en cada query vía `eq(<table>.orgId, auth.orgId)`" — la postura de Janusly por AGENTS.md — no es el mismo commitment arquitectural.
8. Existe algún logging / historial de actividad; "audit row por acción AI, por acción de recovery, por cambio de membership, por cambio de config" con el catálogo cerrado que mantiene Janusly no es lo mismo.
9. n8n tiene un editor visual + el code node de JS; para cualquier flujo no trivial el code node típicamente aparece.
10. Workato tiene un DSL de recipes pero la superficie típica es un builder visual guiado.
11. La superficie primaria de Janusly es el editor visual de DAG + el Inspector. El DSL es JSON tipado por Zod; los operadores típicamente no lo escriben a mano.

**Nota de honestidad sobre la fila de conteo de integraciones.** Zapier, Make, Workato y Pipedream mantienen catálogos crudos más grandes que lo que Janusly tendrá, por diseño. La tabla se lee como justa para que las filas donde Janusly gana se lean como creíbles. Ver Sección D para la lista explícita de lo que cedemos.

### Sección D — Dónde Janusly intencionalmente no compite

La lista "perdemos a propósito". Conocer la frontera es parte de la postura.

- **Conteo de catálogo de integraciones.** Zapier, Make, Workato y Pipedream todos tienen catálogos crudos más grandes y los seguirán teniendo en el futuro previsible. Elegimos un set chico de integraciones relevantes a recuperación (Slack, GitHub, email, signed webhook, cliente + server MCP) por PLAN §16.5. Si la necesidad primaria de un comprador es "conectar 50 SaaS apps que ya funcionan", recomienda que se queden con Zapier o Make para esa superficie.
- **UX no-code, friendly para usuarios no técnicos.** Zapier gana en "mi gerente de marketing construyó esto en 10 minutos". Janusly es para el builder técnico y el ops lead que realmente quiere leer el audit log. Si el usuario primario del comprador es un empleado no técnico construyendo automatizaciones one-off, recomienda Zapier o Gumloop.
- **El punto de entrada hosted no-code más barato.** El tier gratuito de Zapier está optimizado para el comprador que quiere la forma más barata de hospedar la conexión de unas pocas SaaS apps. No cobramos por volumen de tasks — ver [`pricing.md`](pricing.md) para la postura de métrica de valor. Si "automatización hosted lo más barato posible" es el criterio de compra, esto no es un fit.
- **Community / marketplace de templates más grande.** n8n y Zapier llevan años de ventaja en templates crowd-sourced. Janusly entrega 7 demos canónicos bajo [`docs/demos/`](../demos/) curados intencionalmente; no estamos compitiendo por llegar a un millón de templates de community.
- **Deployment air-gapped on-prem.** Fuera de scope para v1 (nombrado explícitamente en los disparadores de descalificación de Etapa 2 de [`icp.md`](icp.md)). Workato gana esta categoría para enterprises compliance-heavy que requieren air-gap.

Un "no educado" en cualquiera de las anteriores es la respuesta correcta de ventas. Descalificar rápido a un comprador de segmento equivocado respeta su tiempo y el nuestro.

### Sección E — Disparadores de compra

Los momentos en que un comprador deja un competidor y pivota hacia Janusly. Cada disparador lista la engineering reality que cumple el momento más el demo con el que liderar.

- **Disparador 1: "Nuestra automatización se rompió a las 3am y no pudimos averiguar por qué."** — Centro de Recuperación (`RecoveryCenterPanel.tsx`) + `POST /ai/explain-run` produce una causa raíz en lenguaje natural anclada en `run_events`. Demo: [failed-workflow-recovery](../demos/failed-workflow-recovery.md).
- **Disparador 2: "Necesitamos un audit log por acción AI para compliance."** — scope multi-tenant en cada query (`eq(<table>.orgId, auth.orgId)`) + `audit_logs` por acción + rollback de `workflow_versions`. Demo: [failed-workflow-recovery](../demos/failed-workflow-recovery.md) + [incident-triage](../demos/incident-triage.md).
- **Disparador 3: "El demo de nuestro agente funciona pero producción se rompe constantemente."** — capa de recovery + `POST /dlq/validate-fix` replay en sandbox (gate de writes-skipped) + `POST /ai/patch-workflow` con alternativas con confidence-score. Demo: [multi-agent-decision](../demos/multi-agent-decision.md) + [failed-workflow-recovery](../demos/failed-workflow-recovery.md).
- **Disparador 4: "Probamos los error workflows de n8n; no explican nada."** — `POST /ai/patch-workflow` retorna 1-3 alternativas con `confidence` (0-100) y `approachLabel` (`add_retry` / `raise_timeout` / `swap_secret_ref` / `add_approval` / `fix_url` / `other`). Demo: [failed-workflow-recovery](../demos/failed-workflow-recovery.md).
- **Disparador 5: "Estamos teniendo sorpresas de costo AI en nuestros flujos."** — governance de presupuesto vía `GET /billing/budget` + caps per-org / per-workflow en `org_configs.ai.budget*` + `workflow_budgets` + chips de cost preview en AI Studio desde `@janusly/shared/src/llm-pricing`. Demo: [failed-workflow-recovery](../demos/failed-workflow-recovery.md) (tour del dashboard de Operations).
- **Disparador 6: "Nuestra agencia reescribe el mismo recovery glue por cada cliente."** — Janusly ES el recovery glue: DLQ + `errorJson` estructurado + replay en sandbox + version rollback + audit por acción + cliente MCP. Demo: [multi-agent-decision](../demos/multi-agent-decision.md) + [mcp-notion-summary](../demos/mcp-notion-summary.md).
- **Disparador 7: "Compliance preguntó quién aprobó esta acción AI."** — `audit_logs` por acción + RBAC con roles custom vía per-org `org_roles` (catálogo de 17 permisos) + SSO vía WorkOS `(en producción)` + SCIM Directory Sync `(en producción)`. Demo: [incident-triage](../demos/incident-triage.md).

Si un disparador es lo que el comprador acaba de decir en voz alta, salta al demo que corresponde. Si dos disparadores coinciden, el comprador es segment-fit — usa la tabla de persona-to-segment al final de [`icp.md`](icp.md) para elegir qué talk track traer.

### Sección F — Sub-bloques por competidor

Un bloque por competidor del AC; siete bloques en total. Cada bloque sigue la misma shape para que un vendedor pueda pattern-matchear en 30 segundos antes de una llamada.

#### F.1 — Zapier

> Lectura de una línea: el líder de catálogo de integraciones y la marca no-code-first para SMB. Catálogo masivo, UX friendly para gerentes de marketing, tier gratuito generoso.

**Dónde son más fuertes.** Tamaño de catálogo (miles de connectors). UX no-code optimizada para no-ingenieros. Confianza de marca en el extremo SMB / single-marketer. Precio del tier gratuito. Años de templates contribuidos por la community. Features AI ("Zapier AI Actions", "Zapier Agents") agregados encima del runtime de integraciones.

**Dónde Janusly es más fuerte.** Centro de Recuperación como home autenticado (`RecoveryCenterPanel.tsx`). Replay en sandbox antes de save (`POST /dlq/validate-fix`). `audit_logs` por acción. `workflow_versions` con rollback en un clic (`POST /workflows/rollback`). Scope multi-tenant enforced a nivel de engine (`eq(<table>.orgId, auth.orgId)` en cada query por AGENTS.md). AI como parte del runtime — los node types `ai` + `agent` + `multi_agent` + `router_llm` son de primera clase, no features de asistente.

**Elige Zapier cuando.** La pregunta del equipo es "¿cuántas SaaS apps puedo conectar en 10 minutos?" — y audit / recovery / version rollback no son prioridades todavía. Usuario primario no técnico. Un budget que necesita el tier de base más barato posible.

**Líneas de manejo de objeciones (lift de [`icp.md`](icp.md)).**

- "Ya tengo Zapier." → *"Zapier es genial cuando tu pregunta es 'cómo conecto SaaS apps que ya funcionan'. Somos la capa a la que vienes cuando una de esas apps falla — Zapier no te ayuda cuando Stripe devuelve un 401 o tu API de billing rota una credencial. Probá nuestro demo de recovery por dos minutos; vas a ver la diferencia inmediatamente."*
- "Zapier es más barato." → *"En el tier gratuito SMB, sí — y si el-más-barato-posible es el criterio, Zapier es la respuesta correcta. Cobramos para equipos que corren flujos donde 'lo más barato' ya no es la pregunta; 'auditable, recuperable, con rollback' lo es."*

**Demo recomendado.** [failed-workflow-recovery](../demos/failed-workflow-recovery.md). Cierra la brecha inmediatamente en la cuña de recovery — el demo corre tanto una falla de missing-secret como una falla de write-side-without-approval end-to-end en 4 minutos.

---

#### F.2 — Make (formerly Integromat)

> Lectura de una línea: Zapier con una UX más friendly para developers, escenarios con branching, iteradores y rutas error-handler. Mejor ergonomía dev que Zapier sin la profundidad de code-step de Pipedream o n8n.

**Dónde son más fuertes.** Editor visual de escenarios con branching + iteradores. Rutas error-handler como patrón núcleo ("en error, hace X"). Friendly para developers comparado con Zapier — los operadores pueden leer la shape JSON de cada paso. Catálogo grande (miles de apps).

**Dónde Janusly es más fuerte.** AI patch suggestions con confidence scores (`POST /ai/patch-workflow` retorna 1-3 alternativas con `approachLabel` + `confidence` 0-100) versus error handlers crudos que solo enrutan a un paso de fallback. Clustering por signature de falla (`packages/shared/src/error-signature.ts` + `GET /dlq/clusters` agrupan fallas repetidas para que el operador vea "47 flujos fallaron por la misma razón" en lugar de 47 filas). Cliente MCP como node type de primera clase. Rollup de MTTR (`GET /recovery/metrics`).

**Elige Make cuando.** El equipo quiere un producto Zapier-shape más friendly para developers y los flujos AI-native no están en scope. El patrón "enrutar a un paso handler" del error path es suficiente y el equipo no le está pidiendo al AI que explique o repare la falla.

**Líneas de manejo de objeciones.**

- "Make tiene rutas error-handler." → *"Los error handlers enrutan el run a un path de fallback que escribiste de antemano. La recovery dialog de Janusly lee la falla, propone 1-3 patches con un confidence score por opción, valida el patch en un sandbox sin tocar el sistema real, y guarda una nueva versión con un clic. Shape diferente."*
- "Nos gusta la UX de escenarios de Make." → *"Quédate con eso para los escenarios simples. Recovery es una pregunta separada — ¿cuándo querés AI en el loop sobre el fix, audit por acción, y version rollback como capacidad core? Ahí es donde estamos nosotros."*

**Demo recomendado.** [failed-workflow-recovery](../demos/failed-workflow-recovery.md).

---

#### F.3 — n8n

> Lectura de una línea: engine de flujos self-host-friendly fair-code con code nodes de JS, community grande, error workflows. La elección default para builders técnicos que quieren self-host y flexibilidad DIY.

**Dónde son más fuertes.** Licencia fair-code (Sustainable Use License). Code nodes de JS directamente en el flujo. Community grande de self-host y marketplace de templates community. Error workflows como patrón built-in. Las adiciones recientes de nodos AI / LangChain amplían significativamente la superficie AI (la tabla marca esto como `partial` porque es real pero bolted-on encima del engine existente, no AI-native).

**Dónde Janusly es más fuerte.** Loop de recuperación como superficie de primera clase — Centro de Recuperación home (`RecoveryCenterPanel.tsx`) + DLQ + clustering por signature de falla — versus error-workflow-as-a-pattern. AI patch suggestions con `confidence` + `approachLabel` versus un code-node "hace algo en error". Version rollback como capacidad core (`POST /workflows/rollback` escribe una row `workflow.rolled_back` en audit en una sola transacción). Cliente Y server MCP (`packages/mcp-server` expone 15 tools read-only + una superficie de write `workflows.save` gated). OTel `service.name="janusly"` end-to-end a través de api + worker + engine.

**Elige n8n cuando.** El equipo quiere escribir JS directamente en los nodos del flujo y está cómodo siendo dueño del runtime. El equipo ya estandarizó en n8n y el costo de migrar es alto. Self-host fair-code es un requisito duro.

**Líneas de manejo de objeciones.**

- "Ya hacemos self-host de n8n." → *"Quédate con eso para los flujos que ya cableaste. La cuña es lo que pasa cuando uno de esos flujos se rompe — la falla explicada por AI, el patch con un confidence score, la validación en sandbox antes de save, el rollback de versión en un clic. Esa es la capa de recovery que tus error workflows no cubren."*
- "n8n tiene nodos AI ahora." → *"Los tienen — y los nodos funcionan. La diferencia arquitectural es dónde vive el AI: sus nodos AI son pasos del flujo; el nuestro es el engine. `POST /ai/patch-workflow` y `POST /ai/explain-run` y `POST /ai/review-workflow` son parte del runtime, no nodos que vos cableás a mano. Commitment diferente."*

**Demo recomendado.** [failed-workflow-recovery](../demos/failed-workflow-recovery.md) + [multi-agent-decision](../demos/multi-agent-decision.md) (follow-up para builder técnico).

---

#### F.4 — Workato

> Lectura de una línea: líder iPaaS enterprise con la librería de connectors más profunda y el asistente AI RecipeIQ. Motion de ventas enterprise, pricing enterprise, governance enterprise.

**Dónde son más fuertes.** Catálogo de connectors enterprise grande. Motion de ventas large-enterprise y track record de procurement. Governance profundo, role-based access, postura multi-environment. RecipeIQ AI assistant para creación de recipes. Opciones de deployment on-prem para clientes compliance-heavy (Janusly cede esto — ver Sección D).

**Dónde Janusly es más fuerte.** AI como parte del engine, no una capa asistente — `POST /ai/generate-workflow` (gramática backed por Anthropic), `POST /ai/patch-workflow` (envelopes de config por node-type + el envelope estructural `insert_approval_upstream` de AGENTS.md), los node types `ai` + `agent` + `multi_agent` + `router_llm` + `agent_reflection` de primera clase. Replay en sandbox antes de save (`POST /dlq/validate-fix` corre un replay con writes-skipped a través del mismo engine y solo gatea el save cuando el sandbox termina `succeeded`). Clustering por signature de falla. MTTR como métrica de registro. Postura de pricing mucho más simple (ver [`pricing.md`](pricing.md) — no lideramos con un mínimo enterprise de 6 cifras).

**Elige Workato cuando.** Una Fortune 500 con 50+ SaaS systems enterprise y un budget de IT multi-millonario. Deployment air-gapped on-prem es un requisito duro. El comprador es un arquitecto enterprise, no un builder.

**Líneas de manejo de objeciones.**

- "Workato tiene RecipeIQ." → *"RecipeIQ te ayuda a escribir la recipe más rápido — se sienta encima del runtime. Somos una capa diferente: cuando la recipe corre en producción y se rompe, nuestro AI lee la falla, propone patches con confidence scores, valida en sandbox antes de save. Complementario al recipe authoring, no un reemplazo."*
- "Workato es el estándar enterprise." → *"Lo es — y no estamos tratando de competir en conteo de connectors. La cuña es recovery y trust operacional para la parte AI-driven de tu portfolio de flujos. Si el dolor del comprador es 'nuestros flujos AI se rompen y no podemos operarlos', esa es nuestra categoría."*

**Demo recomendado.** [incident-triage](../demos/incident-triage.md) — el demo para comprador engineering aterriza más limpio acá que la historia SMB del refund-triage.

---

#### F.5 — Pipedream

> Lectura de una línea: workflow runner serverless event-driven code-first. Code steps de Node.js / Python / Go / Bash como unidad primaria. Tier gratuito generoso, librería grande de event-sources, marca centrada en developers.

**Dónde son más fuertes.** Ergonomía de code-step a través de Node / Python / Go / Bash. Librería de event-sources atada a patrones de webhook para SaaS systems. Tier gratuito generoso para devs solos e indie builders. Las adiciones recientes de features AI amplían la superficie AI (la tabla marca esto como `partial`).

**Dónde Janusly es más fuerte.** Centro de Recuperación versus retry config crudo — la superficie de operador para "qué pasó, por qué, qué hacer después" es un producto construido, no una vista de logs. Fallas explicadas por AI (`POST /ai/explain-run` produce una causa raíz en lenguaje natural anclada en `run_events`). Replay en sandbox antes de save. `audit_logs` por acción con la invariante de scope multi-tenant. Scope multi-tenant a nivel de engine (`eq(<table>.orgId, auth.orgId)` en cada query) para ventas B2B donde la data de un cliente no debe filtrarse cross-tenant.

**Elige Pipedream cuando.** El comprador es un indie dev sin necesidad de compliance y quiere flexibilidad máxima de code. El workload primario son patrones event-source → code-step → llamada de API y "qué pasa si se rompe" es un problema developer-self-service.

**Líneas de manejo de objeciones.**

- "Pipedream es más rápido para flujos code-step." → *"Para flujos pure code-step, sí — están optimizados para eso. La pregunta es operar el flujo después del handoff: quién lee el audit log, quién revisa el patch cuando algo se rompe, quién prueba que el fix funcionó antes de save. Problema diferente."*
- "Pipedream tiene un tier gratuito generoso." → *"Respuesta correcta para un indie dev. Una vez que el flujo está corriendo trabajo customer-facing y 'quién aprobó esta acción AI' se vuelve una pregunta real, el tier es el eje equivocado para optimizar."*

**Demo recomendado.** [multi-agent-decision](../demos/multi-agent-decision.md) — el demo para comprador técnico AI cae bien en una audiencia code-first y muestra la capacidad multi-agent que Pipedream no tiene como concepto de primera clase.

---

#### F.6 — Relay

> Lectura de una línea: workflow tool AI-native con UX limpia y énfasis en human-in-the-loop. Producto más joven, set de integraciones más chico, foco en la shape de flujo AI-first.

**Dónde son más fuertes.** UX de builder AI-first limpia. El énfasis en human-approval aterriza bien en compradores preocupados por autonomía AI. Producto más joven significa menos decisiones legacy que defender.

**Dónde Janusly es más fuerte.** Runtime DAG observable anclado en `run_events` + OTel `service.name="janusly"` end-to-end. Centro de Recuperación como home screen. Replay en sandbox (`POST /dlq/validate-fix`). Rollback de `workflow_versions`. Cliente + server MCP. Audit log por acción. Clustering por signature de falla. Misma shape fundamental de producto con una superficie de operador sustancialmente más profunda y los invariantes de engineering documentados en AGENTS.md. Scope multi-tenant a nivel de engine como commitment fundacional, no una línea de roadmap.

**Elige Relay cuando.** El comprador quiere la superficie de flujo AI más simple posible y no necesita la profundidad de recovery / audit / replay. Sus flujos son net-new AI-first; no están migrando desde una plataforma existente más pesada.

**Líneas de manejo de objeciones.**

- "La UX de Relay es más limpia." → *"Para un flujo AI-first simple, lo es. La pregunta es cómo se ve la superficie el día después de que el flujo va a producción: cuando un paso falla, qué muestra la recovery dialog, qué hay en el audit log, podés hacer rollback a una versión. Ahí es donde la profundidad aparece."*
- "Relay también tiene human approval." → *"Correcto — human approval como node es table stakes para nuestra categoría. Donde vamos más lejos es la recovery dialog: AI propone 1-3 patches con confidence scores, el sandbox valida antes de save, la versión se guarda con una row `workflow.rolled_back` disponible en audit para rollback en un clic. Mismo principio human-in-the-loop, más superficie."*

**Demo recomendado.** [failed-workflow-recovery](../demos/failed-workflow-recovery.md) — muestra la profundidad de superficie de operador que el producto más chico no puede reproducir todavía.

---

#### F.7 — Gumloop

> Lectura de una línea: builder drag-and-drop de flujos AI para no-ingenieros. La UX de builder AI más simple, tiempo a primer flujo más rápido, usuario primario no técnico.

**Dónde son más fuertes.** UX de builder AI más simple en la categoría. Tiempo más rápido a primer flujo AI para un no-ingeniero. Friendly para equipos de marketing, motion de compra "lo construí en una tarde".

**Dónde Janusly es más fuerte.** Centro de Recuperación como home screen. Replay en sandbox antes de save. Rollup de MTTR (`GET /recovery/metrics`) como métrica maestra. `audit_logs` por acción. RBAC vía per-org `org_roles` con el catálogo de 17 permisos. SSO vía WorkOS `(en producción)` y SCIM Directory Sync `(en producción)`. Somos para el operador que vive con el flujo en producción; Gumloop es para el prototipador.

**Elige Gumloop cuando.** El equipo es no técnico y el criterio de compra es "demo de flujo AI para el viernes". El flujo es one-off, low-stakes, no customer-facing. Audit / recovery / RBAC no están en la lista del comprador.

**Líneas de manejo de objeciones.**

- "Gumloop es más fácil para empezar." → *"Correcto — para el primer flujo del día uno. La pregunta cambia el día 30: quién lee el audit log cuando finance pregunta, quién revisa el patch cuando se rompe, podés hacer rollback a la versión de la semana pasada. Esa es nuestra categoría."*
- "No tenemos ingenieros." → *"Entonces no son segment-fit para nosotros hoy — y esa es una respuesta honesta. Somos para el builder técnico + el ops lead. Si no tenés ninguno de los dos roles en el equipo, Gumloop es mejor fit."*

**Demo recomendado.** [failed-workflow-recovery](../demos/failed-workflow-recovery.md) + [incident-triage](../demos/incident-triage.md) — muestra tanto el loop de recovery COMO la profundidad de superficie de operador, después pregunta si el comprador tiene a alguien en el equipo que realmente lo usaría.

---

### Sección G — Mapa de demos

El cheat sheet "el comprador mencionó al competidor X, pre-carga el demo Y". Usa esta tabla para armar la agenda de la llamada antes de marcar. Nombres de archivos de demo verbatim de [`docs/demos/`](../demos/).

| El comprador mencionó | Liderar con | Demo de follow-up | Segmento canónico de [`icp.md`](icp.md) |
| --- | --- | --- | --- |
| Zapier | [failed-workflow-recovery](../demos/failed-workflow-recovery.md) | [refund-triage](../demos/refund-triage.md) | B2B startups with ops workflows |
| Make (Integromat) | [failed-workflow-recovery](../demos/failed-workflow-recovery.md) | [refund-triage](../demos/refund-triage.md) | B2B startups with ops workflows |
| n8n | [failed-workflow-recovery](../demos/failed-workflow-recovery.md) | [multi-agent-decision](../demos/multi-agent-decision.md) | Engineering/support teams |
| Workato | [incident-triage](../demos/incident-triage.md) | [failed-workflow-recovery](../demos/failed-workflow-recovery.md) | Engineering/support teams |
| Pipedream | [multi-agent-decision](../demos/multi-agent-decision.md) | [failed-workflow-recovery](../demos/failed-workflow-recovery.md) | AI builders/agencies |
| Relay | [failed-workflow-recovery](../demos/failed-workflow-recovery.md) | [multi-agent-decision](../demos/multi-agent-decision.md) | AI builders/agencies |
| Gumloop | [failed-workflow-recovery](../demos/failed-workflow-recovery.md) | [incident-triage](../demos/incident-triage.md) | Descalificar primero; si es segment-fit → B2B startups with ops workflows |

Después de elegir el demo, confirma fit de segmento contra la tabla de persona-to-segment al final de [`icp.md`](icp.md). Si la persona en la llamada no aparece en esa tabla, fit de segmento es la primera conversación, no el demo.

### Sección H — Principio de anti-posicionamiento, recapitulado

La postura competitiva más creíble es la que nombra lo que SOMOS y deja que el comprador infiera el resto.

- **Nombramos lo que SOMOS.** Runs observables. Fallas explicadas. Patches revisables. Runs reproducibles.
- **Nombramos lo que NO SOMOS.** No una mejor UI de Zapier. No n8n con AI. No RPA genérico. No agentes que hacen todo.
- **Nunca nombramos lo que está mal en la competencia por nombre en copy customer-facing.** Eso pertenece solo a este doc interno.

Cuando el nombre de un competidor aparece en un deck, un email de ventas, una landing page o un podcast, la línea es: *"Somos una categoría diferente — somos para [nuestra lista SOMOS]. Si tu pregunta es [su fortaleza], ellos son una gran respuesta."* Después seguís.

**La métrica de registro.** MTTR para automatizaciones fallidas. De horas a minutos, de minutos a segundos. Cada demo vuelve a ella; cada slide de business case la cita; cada medición de la beta privada (ENG-093) se ancla en ella. Es el número al que nos sostenemos, y es el número con el que le pedimos al comprador que nos mida.

### Sección I — Lo que NO está en este doc

La lista explícita de out-of-scope, para que ni ventas ni fundadores sobrecarguen este paquete accidentalmente:

- **Sin montos en dólares.** Las comparaciones de pricing pertenecen a [`pricing.md`](pricing.md). Este doc nombra ventaja estructural; no nombra brechas de precio.
- **Sin competitive intel en vivo.** Las capacidades de productos competidores pueden cambiar rápido. El doc nombra la shape estructural de cada competidor al momento de autoría, no conteos específicos de features que se vuelven stale. Las notas al pie usan calificadores ("miles de integraciones", "el líder de catálogo por tamaño") en lugar de números con fecha.
- **Sin páginas de comparación public-facing.** Este es el doc interno de ventas. `/compare/zapier`, `/compare/n8n`, y landing pages públicas similares son tickets futuros de web-implementation, no parte de este paquete.
- **Sin boilerplate de RFP ni respuestas a vendor security questionnaires.** Compliance pide respuestas específicas; esas pertenecen a un playbook de enterprise-sales separado.
- **Sin proceso de competitive-intel monitoring.** Observar releases / cambios de pricing de competidores es un proceso operativo dueño de fundadores + ventas, no un doc.
- **Sin localización UI de la página competitiva pública.** Este doc interno de ventas SÍ es bilingüe (es lo que estás leyendo); solo la superficie de las web pages `/compare/*` queda diferida a un ticket de web-implementation separado.

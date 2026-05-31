# Recovery Focus Ticket Backlog - May 31, 2026

> Status: candidate planning backlog, not the active roadmap.
> Canonical ticket status remains in `docs/ROADMAP.md`.
> Default decision for every item is `Undecided` until the owner promotes it.

This backlog turns the May 31 product audit into implementation-shaped tickets
without assuming every suggestion should ship. The goal is to help the owner
choose deliberately.

Janusly's product center stays narrow:

> Janusly is the recovery and control plane for AI workflows that matter in
> production.

Every proposed ticket should pass at least one of these gates:

1. Reduces time-to-first-recovered-run.
2. Reduces median MTTR for failed workflows.
3. Increases operator trust in patch, replay, rollback, or evidence.
4. Removes product confusion that makes Janusly feel like a generic workflow
   builder.

If a ticket passes none of those gates, pause it.

## How To Use This Backlog

For each ticket, set exactly one owner decision:

- `Do now` - promote into the active roadmap.
- `Defer` - keep for later, with a reason.
- `Reject` - remove from candidate scope.
- `Needs discussion` - keep open until the product decision is clearer.

Do not implement directly from this file. Copy selected tickets into
`docs/ROADMAP.md` or the chosen issue tracker with final IDs, sequencing, and
owner decisions.

## Recommended First Batch

The smallest high-leverage batch is:

1. RF-001 - Run the private-beta MTTR experiment.
2. RF-002 - Build the first recovered run golden path.
3. RF-003 - Instrument the recovery funnel.
4. RF-006 - Simplify default navigation around Recovery Center.
5. RF-010 - Refresh README as the state-of-truth.
6. RF-011 - Decide and document AI generation/provider posture.
7. RF-012 - Split roadmap into active roadmap plus archive.

That batch validates the wedge and reduces scope confusion before adding more
platform surface.

## Ticket Matrix

| ID | Title | Priority | Effort | Risk | Decision |
| --- | --- | --- | --- | --- | --- |
| RF-001 | Run private-beta MTTR experiment | P0 | M | Medium | Undecided |
| RF-002 | First recovered run golden path | P0 | L | Medium | Undecided |
| RF-003 | Recovery funnel instrumentation | P0 | M | Low | Undecided |
| RF-004 | Recovery evidence report v1 | P1 | M | Medium | Undecided |
| RF-005 | Workflow Recovery Score | P1 | L | Medium | Undecided |
| RF-006 | Simplify default navigation | P0 | M | Medium | Undecided |
| RF-007 | Feature visibility tiers | P0 | M | Medium | Undecided |
| RF-008 | Recovery Center command entrypoint | P1 | M | Medium | Undecided |
| RF-009 | Narrow solution packs to recovery demos | P1 | S | Low | Undecided |
| RF-010 | README state-of-truth refresh | P0 | S | Low | Undecided |
| RF-011 | AI generation/provider posture | P0 | S | Medium | Undecided |
| RF-012 | Active roadmap plus archive split | P0 | M | Low | Undecided |
| RF-013 | Product decision record: Recovery Center as home | P1 | S | Low | Undecided |
| RF-014 | Integration acceptance rule | P0 | S | Low | Undecided |
| RF-015 | Hide non-core surfaces for new orgs | P1 | M | Medium | Undecided |
| RF-016 | Delete or retire legacy OperationsPanel | P2 | S | Low | Undecided |
| RF-017 | Patch quality evaluation loop | P1 | L | Medium | Undecided |
| RF-018 | Value dashboard gated on beta baseline | P1 | M | Low | Undecided |

---

## RF-001 - Run Private-Beta MTTR Experiment

**Problem:** Janusly has shipped much of the platform surface, but the core
commercial claim still needs real-world validation: Janusly reduces MTTR for
failed AI workflows.

**Outcome:** Three design partners run production-shaped workflows through
Janusly for the private-beta window, producing baseline MTTR, observed MTTR,
setup friction, failure categories, and willingness-to-pay signal.

**Scope:**
- Use `docs/marketing/private-beta-playbook.md` as the operating handbook.
- Recruit and qualify 3 design partners.
- Run the 60-minute kickoff for each partner.
- Track weekly recovery activity and MTTR samples.
- Publish an internal private-beta report.

**No-goals:**
- No new product surface unless a beta blocker requires it.
- No public pricing numbers before the report.
- No custom feature promises to close beta partners.

**Acceptance criteria:**
- 3 partners recruited or an explicit "could not recruit" report exists.
- Each partner has 3 target workflows named.
- Baseline MTTR captured before install.
- Post-install recovery events captured from runtime data.
- Final report states whether Recovery Center remains product home.

**Metric:** 2 of 3 partners show measurable MTTR improvement, or the report
explains why the wedge failed.

**Effort/Risk:** M effort, medium risk because this is operational work more
than code.

**Decision:** Undecided.

## RF-002 - First Recovered Run Golden Path

**Problem:** The product has the primitives for recovery, but a new operator can
still wander across AI Studio, templates, packs, runs, operations, credentials,
and members before seeing the core value.

**Outcome:** A new org can reach one recovered run in under 10 minutes through a
single guided path.

**Scope:**
- Add a guided Recovery Center path for the canonical failed-workflow demo.
- Start from a seeded workflow or solution pack.
- Run a known failing payload.
- Open the failed item.
- Explain, patch, sandbox validate, save, replay, and show green result.
- End with a small evidence summary.

**No-goals:**
- No generic onboarding framework.
- No marketplace.
- No new workflow node types.
- No production auto-apply.

**Acceptance criteria:**
- Fresh dev org shows one primary CTA for the recovery demo.
- The path can be completed with fallback AI mode.
- The path can be completed with real AI mode.
- The final screen shows replay status and the MTTR/time-to-recover signal.
- E2E smoke covers the path.

**Metric:** Median time-to-first-recovered-run under 10 minutes in founder-run
onboarding.

**Effort/Risk:** L effort, medium risk because it crosses web, API, seed data,
and demo fixtures.

**Decision:** Undecided.

## RF-003 - Recovery Funnel Instrumentation

**Problem:** Janusly cannot evaluate the wedge unless it measures where users
drop from first run to recovered failure.

**Outcome:** Product analytics and/or internal tables capture the recovery
funnel without relying on manual notes.

**Scope:**
- Record events for first workflow saved, first run started, first failed run,
  first DLQ open, first explanation requested, first patch suggested, first
  sandbox validation, first saved patch, first replay, and first recovered run.
- Keep org and user scoping.
- Add an internal report query or route for the funnel.

**No-goals:**
- No third-party analytics dependency unless separately approved.
- No PII-heavy event payloads.
- No public dashboard yet.

**Acceptance criteria:**
- Funnel events are persisted or derivable from existing runtime tables.
- A local script or route can output per-org funnel state.
- Tests cover event derivation for empty org, partially onboarded org, and
  recovered org.

**Metric:** Funnel visibility for 100 percent of beta partners.

**Effort/Risk:** M effort, low risk if derived from existing runtime signals.

**Decision:** Undecided.

## RF-004 - Recovery Evidence Report V1

**Problem:** The strongest product claim is not just that Janusly fixes a
workflow, but that it leaves evidence: what broke, what changed, who approved,
what sandbox proved, and what replay did.

**Outcome:** Each recovered item can produce a compact evidence report suitable
for an operator, founder, or compliance reviewer.

**Scope:**
- Generate report from run events, audit logs, DLQ state, patch diff,
  validation run, replay result, and recovery feedback.
- Include deterministic fallback text when AI is unavailable.
- Render in web and expose JSON from API.

**No-goals:**
- No PDF export in v1 unless existing report infrastructure makes it trivial.
- No customer-branded report builder.
- No external share links.

**Acceptance criteria:**
- Report includes cause, patch summary, validation result, replay result,
  approver, timestamps, and audit references.
- Report works for AI and fallback patch paths.
- Report excludes secrets and raw credential values.
- Tests cover redaction and missing-data fallback.

**Metric:** 100 percent of recovered beta failures have an evidence artifact.

**Effort/Risk:** M effort, medium risk because evidence spans several tables.

**Decision:** Undecided.

## RF-005 - Workflow Recovery Score

**Problem:** Operators need to know whether a workflow is recoverable before it
fails, not only after DLQ captures a failure.

**Outcome:** Each workflow has a simple recovery readiness score with concrete
reasons and suggested fixes.

**Scope:**
- Score workflows on rollback target, declared inputs, outputs, credential
  health, write-side approvals, retry/timeout posture, SLO presence, and recent
  recovery success.
- Surface score in Workflows dashboard and Inspector.
- Link each issue to an actionable fix.

**No-goals:**
- No LLM-only scoring.
- No opaque numeric health score without reason rows.
- No blocking save by default.

**Acceptance criteria:**
- Score is deterministic and testable.
- Each score component has a reason code.
- Empty/demo orgs do not look broken.
- Score improves after the recommended fix is applied.

**Metric:** Increase percentage of beta workflows with all critical recovery
readiness checks passing.

**Effort/Risk:** L effort, medium risk because the score must stay explainable.

**Decision:** Undecided.

## RF-006 - Simplify Default Navigation Around Recovery Center

**Problem:** The app navigation currently exposes many platform surfaces up
front, which makes Janusly feel like a broad automation suite instead of a
recovery-first operator.

**Outcome:** New/default orgs see a smaller navigation centered on Recovery
Center, Runs, Workflows, AI Studio, and Operations. Advanced surfaces remain
available but are not first-impression noise.

**Scope:**
- Define a default nav mode and an advanced nav mode.
- Keep Recovery Center pinned.
- Move Marketplace, Multi-agent, Members, and low-frequency admin surfaces
  behind advanced/admin mode where appropriate.
- Preserve deep links and command palette access.

**No-goals:**
- No route deletion.
- No permission model rewrite.
- No mobile redesign.

**Acceptance criteria:**
- New org default nav has fewer primary items.
- Existing orgs can still reach advanced surfaces.
- Tests cover tab availability and persisted sidebar state.
- Screenshots show the first viewport reads recovery-first.

**Metric:** Lower setup confusion in kickoff notes and faster
time-to-first-recovered-run.

**Effort/Risk:** M effort, medium risk because nav touches product perception
and tests.

**Decision:** Undecided.

## RF-007 - Feature Visibility Tiers

**Problem:** Janusly needs a way to keep advanced platform work in the product
without forcing every operator to see every surface at once.

**Outcome:** Features are classified as `core`, `supporting`, `advanced`,
`hidden`, or `paused`, and the app uses that classification for navigation and
empty states.

**Scope:**
- Add a feature visibility registry in web code.
- Use it to decide nav items, empty-state CTAs, and command-palette entries.
- Document which current surfaces belong to each tier.

**No-goals:**
- No billing-tier implementation.
- No license enforcement.
- No per-feature permission engine beyond existing role/permission checks.

**Acceptance criteria:**
- Feature tier is declared in one place.
- Navigation consumes the registry.
- Advanced features can be hidden for new orgs without deleting code.
- Tests cover visibility for default and advanced mode.

**Metric:** Fewer first-session clicks into non-core surfaces during beta.

**Effort/Risk:** M effort, medium risk because hidden features must remain
reachable for existing users.

**Decision:** Undecided.

## RF-008 - Recovery Center Command Entry Point

**Problem:** The Recovery Center has become the product home, but it should also
be the fastest way to take the next operational action.

**Outcome:** The Recovery Center composer/command entry suggests contextual
actions: recover latest failure, open stuck approval, inspect unhealthy
workflow, run demo failure, configure missing credential, or review budget.

**Scope:**
- Add deterministic command suggestions based on current org state.
- Route suggestions to existing tabs/drawers.
- Keep AI phrasing optional and fallback-safe.

**No-goals:**
- No autonomous execution.
- No natural-language router that can mutate production state.
- No new backend workflow engine path.

**Acceptance criteria:**
- Empty org suggests the recovery demo.
- Org with DLQ suggests opening the highest-priority recovery item.
- Org with missing credentials suggests credential setup.
- Suggestions are deterministic when no LLM key is configured.

**Metric:** Increase percentage of sessions that start in Recovery Center and
complete a recovery-related action.

**Effort/Risk:** M effort, medium risk because actions must be safe and clear.

**Decision:** Undecided.

## RF-009 - Narrow Solution Packs To Recovery Demos

**Problem:** Solution packs can support onboarding, but can also drift into a
generic template marketplace.

**Outcome:** Solution packs serve only the recovery wedge until beta proves a
broader marketplace is needed.

**Scope:**
- Keep 3 canonical packs: failed workflow recovery, refund triage, incident
  triage.
- Ensure each pack has a sample run and a failure fixture.
- Add labels that emphasize "recoverable workflow starter" rather than
  marketplace breadth.

**No-goals:**
- No large catalog.
- No third-party pack submissions.
- No pack marketplace positioning.

**Acceptance criteria:**
- Every visible pack can demonstrate failure and recovery.
- Pack install leads to the golden path or a recovery-ready workflow.
- UI copy avoids integration-count framing.

**Metric:** Pack installs that lead to a recovered run.

**Effort/Risk:** S effort, low risk.

**Decision:** Undecided.

## RF-010 - README State-Of-Truth Refresh

**Problem:** The README is the first product contract, but parts of it can drift
behind the current implementation and AGENTS notes.

**Outcome:** README accurately describes the current stack, package list,
AI-provider posture, MCP posture, migration posture, and test/gate commands.

**Scope:**
- Update package list.
- Refresh test count language to avoid brittle counts.
- Align MCP client/server description with current implementation.
- Align AI generation/provider posture with RF-011 decision.
- Verify quick start still matches current scripts.

**No-goals:**
- No broad marketing rewrite.
- No roadmap migration into README.
- No changing product positioning unless RF-013 changes it.

**Acceptance criteria:**
- README does not contradict AGENTS, docs/ai.md, or implemented package
  surfaces.
- Quick start runs or documented prerequisites are accurate.
- Test command descriptions avoid stale numeric claims.

**Metric:** New contributor can run quick start without doc correction from
the maintainer.

**Effort/Risk:** S effort, low risk.

**Decision:** Undecided.

## RF-011 - AI Generation And Provider Posture

**Problem:** The repo contains provider abstraction and current free-JSON
generation work, while docs still describe OpenAI as registered but not
verified for runtime generation. The product needs one clear operating posture.

**Outcome:** Janusly has an explicit, tested stance for AI generation modes and
providers.

**Scope:**
- Decide supported provider(s) for v1.
- Decide whether `free_json` is default, experimental, or internal-only.
- Document fallback behavior and eval requirements.
- Update README, docs/ai.md, `.env.example`, and org config descriptions after
  the decision.

**No-goals:**
- No multi-provider promise unless verified by evals and live smoke.
- No removing deterministic fallback.
- No provider-specific code outside the LLM abstraction.

**Acceptance criteria:**
- Docs state one supported posture with no contradictions.
- Eval evidence is attached or referenced for any supported generation mode.
- Unsupported providers degrade predictably.
- AI health/status includes enough mode/provider detail for operators.

**Metric:** `/ai/generate-workflow` success and validation rate by provider and
generation mode.

**Effort/Risk:** S effort for decision/docs, medium risk if it changes default
runtime behavior.

**Decision:** Undecided.

## RF-012 - Active Roadmap Plus Archive Split

**Problem:** `docs/ROADMAP.md` has become a large shipped-history ledger. That
makes it hard to see what is actually next.

**Outcome:** Janusly has a short active roadmap and a separate archive for
completed historical tickets.

**Scope:**
- Keep active roadmap to current/pending/next work.
- Move shipped historical detail into an archive document or generated ledger.
- Preserve ticket history and links.
- Add clear rules for when tickets move to archive.

**No-goals:**
- No ticket renumbering.
- No rewriting historical summaries.
- No deleting shipped context.

**Acceptance criteria:**
- Active roadmap is scannable in under 5 minutes.
- Shipped history remains searchable.
- Pending/Gated/Deferred work is easy to find.
- Existing cross-links still resolve or have replacement anchors.

**Metric:** Maintainer can identify the top 10 active decisions without
searching a 500KB file.

**Effort/Risk:** M effort, low risk if done mechanically with link checks.

**Decision:** Undecided.

## RF-013 - Product Decision Record: Recovery Center As Home

**Problem:** The product has implicitly chosen Recovery Center as home, but that
decision should be explicit so future tickets do not re-expand the product into
a generic workflow builder.

**Outcome:** A short product decision record states that Recovery Center remains
home until ENG-093/private-beta data says otherwise.

**Scope:**
- Document decision, context, tradeoffs, and reversal condition.
- Link README, PLAN, narrative, ICP, and private-beta playbook.
- Name what this decision does not mean: AI Studio and builder surfaces still
  exist, but they support recovery.

**No-goals:**
- No redesign.
- No implementation changes.
- No permanent decision that ignores beta evidence.

**Acceptance criteria:**
- Decision record includes a dated reversal condition.
- New tickets can reference it when deciding whether a surface is core.

**Metric:** Fewer roadmap items that do not pass the recovery gate.

**Effort/Risk:** S effort, low risk.

**Decision:** Undecided.

## RF-014 - Integration Acceptance Rule

**Problem:** Raw integration breadth is a losing race against Zapier, n8n,
Workato, Make, and Pipedream. Janusly should add integrations only when they
serve recoverable production workflows.

**Outcome:** New integrations require a recovery-centered justification before
entering roadmap.

**Scope:**
- Add a short rule to planning docs or AGENTS.
- Require each new integration to name the demo, customer workflow, failure
  mode, recovery path, credentials story, and write-side/sandbox behavior.

**No-goals:**
- No removal of existing integration tools.
- No blocking customer-pulled integrations.
- No connector marketplace.

**Acceptance criteria:**
- New integration tickets include a failure/recovery story.
- Tickets without that story are deferred by default.

**Metric:** Zero roadmap additions justified only by connector count.

**Effort/Risk:** S effort, low risk.

**Decision:** Undecided.

## RF-015 - Hide Non-Core Surfaces For New Orgs

**Problem:** Marketplace, Multi-agent, experiments, eval datasets, and some
admin surfaces may be valuable later, but they dilute the first product
impression.

**Outcome:** New orgs see a recovery-first app by default; advanced surfaces
remain available via explicit mode, permission, or direct link.

**Scope:**
- Hide or de-emphasize Marketplace and Multi-agent from default nav.
- Keep Runs, Workflows, AI Studio, Recovery Center, Operations, and Credentials
  discoverable.
- Hide eval/experiment admin surfaces unless enabled.

**No-goals:**
- No deleting code.
- No data migration.
- No changing route permissions as the primary mechanism.

**Acceptance criteria:**
- New org first session has recovery-first navigation.
- Existing advanced URLs do not 404.
- Command palette either hides advanced entries or labels them clearly.

**Metric:** Faster first recovered run and fewer beta notes about "too much
product."

**Effort/Risk:** M effort, medium risk because hidden features must not break
existing workflows.

**Decision:** Undecided.

## RF-016 - Delete Or Retire Legacy OperationsPanel

**Problem:** `OperationsPage` replaced the legacy vertical `OperationsPanel`,
but the old file remains in tree as cleanup debt.

**Outcome:** Operations has one active implementation path.

**Scope:**
- Confirm no imports reference the legacy panel.
- Move any reusable helpers out if needed.
- Delete or mark legacy panel as intentionally retained.
- Update tests.

**No-goals:**
- No Operations redesign.
- No new admin cards.
- No rail behavior changes.

**Acceptance criteria:**
- Static search shows no dead imports.
- Tests still cover OperationsPage.
- Bundle does not include legacy code through accidental imports.

**Metric:** Reduced web maintenance surface.

**Effort/Risk:** S effort, low risk.

**Decision:** Undecided.

## RF-017 - Patch Quality Evaluation Loop

**Problem:** Janusly should know whether patch suggestions are operationally
useful, not just whether the LLM returned valid JSON.

**Outcome:** Patch quality is measured through validation pass rate, operator
acceptance, rejection reason, rollback-after-patch, and replay success.

**Scope:**
- Build aggregate reports from `recovery_feedback`, validation runs, replay
  results, and rollback events.
- Segment by approach label and error category.
- Feed summary back into AI prompt context only when safe and scoped.

**No-goals:**
- No subjective LLM judge as the primary metric.
- No cross-org learning.
- No automatic production mutation.

**Acceptance criteria:**
- Report shows patch attempts, validation pass rate, accept rate, replay
  success, and rollback-after-patch.
- Metrics are tenant-scoped.
- Tests cover missing feedback and fallback paths.

**Metric:** High-confidence patch suggestions achieve the target validation and
acceptance rate chosen after beta baseline.

**Effort/Risk:** L effort, medium risk because quality metrics can be
misleading without enough samples.

**Decision:** Undecided.

## RF-018 - Value Dashboard Gated On Beta Baseline

**Problem:** A value dashboard can help sales, but estimated savings are weak
unless tied to real baseline and runtime data.

**Outcome:** The value dashboard stays honest: hard runtime metrics first,
estimated dollar savings only when baseline assumptions are set.

**Scope:**
- Keep "awaiting private-beta data" state when baseline is unset.
- Add a clear setup path for baseline MTTR and minutes-saved assumptions.
- Link value metrics to recovered failures, replay rate, and MTTR delta.

**No-goals:**
- No fabricated ROI.
- No default dollar savings without an explicit assumption.
- No public case-study claim before permission.

**Acceptance criteria:**
- Dashboard distinguishes hard runtime data from configured assumptions.
- Empty baseline renders neutral/pending.
- Report exports include assumptions used.

**Metric:** Value dashboard claims can be traced to runtime data or explicit
operator assumptions.

**Effort/Risk:** M effort, low risk.

**Decision:** Undecided.

## Items To Reject By Default

These should not become tickets unless a customer creates concrete pull:

- Competing on raw connector count.
- Building a large public marketplace before the beta closes.
- Adding new node types that do not support a canonical recovery demo.
- Public pricing numbers before ENG-093 data.
- Fully autonomous production mutation as default behavior.
- Air-gapped enterprise deployment for v1.
- Public competitor attack pages before private-beta proof.

## Owner Decision Checklist

Before promoting any ticket, answer:

1. Which recovery gate does it pass?
2. Which beta partner or demo needs it?
3. What is the smallest version that proves the value?
4. What will be hidden, deferred, or rejected to keep scope flat?
5. What metric changes if it works?

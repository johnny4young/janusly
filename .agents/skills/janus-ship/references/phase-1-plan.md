# PHASE 1 — Plan (detailed)

The goal of PHASE 1 is to land an Accept-or-Reject decision via the Plan panel UI. No code is written. Only the plan file gets touched.

## Step 1 — EnterPlanMode

Call EnterPlanMode as the very first action of the turn. This:

- Turns on the hand icon and Plan panel sidebar.
- Restricts Edit/Write to the plan file only.
- Signals to the user that the agent is in plan mode.

If `EnterPlanMode` and `ExitPlanMode` are deferred tools, load them first with:

    ToolSearch query="select:EnterPlanMode,ExitPlanMode"

## Step 2 — Pick a ticket

The pool is the rows in `docs/ROADMAP.md` §3b with `Status ∈ {Pending, Partial}`. Skip `Gated` and `Deferred`.

Selection rules in priority order:

1. **User-named target wins.** When the user names an ENG-NNN or feature in the same turn, use that target — even if heuristics would pick something else.
2. **Prefer Partial over Pending.** Existing scaffolding lowers risk. The implementable scope of a Partial is the `Remaining:` line at the end of its Scope cell.
3. **Respect dependencies.** When a Pending depends on a non-Shipped ticket, skip it and pick another.
4. **Follow §3a sequencing.** When several tickets are equally eligible, follow the sequencing recommendation in `docs/ROADMAP.md` §3a.

## Step 3 — Read the right context

Before drafting the plan, read:

- The selected ticket's row in `docs/ROADMAP.md` §3b (full Scope cell).
- The relevant code paths (`apps/api/src/...`, `apps/web/src/...`, `packages/<x>/src/...`) — only what the ticket touches.
- A specific `docs/PLAN.md` section ONLY when the ticket touches one of: AI provider direction, MCP, RL/memory, node catalog, multi-tenant maturity, roadmap phases. Cite the section in the plan output.
- Existing tests near the touched code (to copy patterns, not just to run them).

Do NOT read README.md to decide scope. README is descriptive, not a planning source.

## Step 4 — Write the plan

The plan goes both in the chat AND in the plan file at `~/.claude/plans/<slug>.md` (ExitPlanMode reads from there). Use this structure:

    Proposed: ENG-NNN — <one-liner>

    Origin: <"user-named" | "ROADMAP §3b auto-pick" | "docs/PLAN.md §X reference">
    Status before: <Pending | Partial>
    Priority: <P0|P1|P2|P3>
    Phase: <1|2|3|4|—>

    Scope:
    - For Partial: copy the "Remaining:" line and mark what gets attacked now.
    - For Pending: 4-8 bullets summarizing scope.

    Logical commits (mental organization only — not executed):
    - <commit 1 description>
    - <commit 2 description>

    Files to create or modify:
    - apps/api/src/...
    - apps/web/src/...
    - packages/<x>/src/...

    Edge-case tests to add:
    - Empty input / loading state / network error / invalid input
    - Multi-tenant scope verification (org_id filter present)
    - Permissions check (viewer / editor / admin behavior)
    - AI fallback path (when ticket touches AI surface)
    - Cancellation path (when ticket touches run lifecycle)

    Coupled invariants at risk: <list from invariants.md, only the ones at risk>

    docs/PLAN.md reference: <section number + title, or "n/a">

    Risks / open questions:
    - ... (these do NOT block Accept; they inform the human)

    Time estimate: <X hours>

    Constraints understood: AGENTS.md, ticket AC, this prompt.

See [`../examples/plan-example.md`](../examples/plan-example.md) for a worked example on a real Janusly ticket.

## Step 5 — ExitPlanMode

Call ExitPlanMode as the last action of PHASE 1. The Plan panel UI then shows the plan with Accept/Reject buttons.

Do NOT write "wait for my response" or any equivalent verbal contract. The UI handles the gate. After Accept, a system message ("User has approved your plan") triggers PHASE 2 automatically. After Reject, wait for textual feedback.

The plan file written to `~/.claude/plans/<slug>.md` stays outside git on purpose — it is not a deliverable. Do not copy it into `docs/`.

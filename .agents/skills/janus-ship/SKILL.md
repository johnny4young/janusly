---
name: janus-ship
description: This skill should be used in the Janusly repository when the user wants to make progress on the roadmap. Specific triggers include "ship the next ticket", "implement the next ENG-NNN", "close the next pending", "work on the next Partial", "attack ENG-XXX", "what's next on the roadmap", "pick up the next thing", "let's tackle the next roadmap item", or any specific ENG-NNN id (e.g. "ENG-008", "do ENG-014"). The skill picks a ticket from docs/ROADMAP.md §3b (Pending or Partial), drafts a structured plan in Plan mode, awaits Accept via the Plan panel UI, then executes with doc-sync, gates (pnpm build/test, typescript-react-reviewer, node) and a unified Conventional Commits suggestion. Never runs mutating git beyond the final `git add`. Use this skill any time the user wants to make progress on Janusly even if they don't say "janus-ship" or "ship" — they may just say "next", name a ticket id, or describe a feature already captured in the roadmap.
---

# janus-ship — Plan-mode gated implementation for Janusly

This skill turns "ship the next thing" into a two-phase workflow with a human gate in the middle:

- **PHASE 1 — Plan.** Pick a ticket from `docs/ROADMAP.md` §3b, draft a structured plan, wait for Accept on the Plan panel UI.
- **PHASE 2 — Execute.** Implement the approved plan, run gates, doc-sync, stage, print a final report and a single Conventional Commits suggestion.

The agent never runs `git commit`, `git push`, `git amend`, `git reset`, or `git branch`. The only mutating git call is the final `git add` on the explicit list of staged paths. The human commits manually.

## When to use

Trigger on any of these phrases or their close paraphrases:

- "Ship the next ticket / next ENG / next pending / next partial"
- "Implement ENG-NNN" (with a specific id)
- "Close the next ROADMAP item"
- "Attack the next thing on the roadmap"
- "Next janus / next janusly ticket"

When the user names an ENG-NNN explicitly, that ticket is the target. When the user says "next", pick from `docs/ROADMAP.md` §3b among `Status ∈ {Pending, Partial}`, preferring `Partial` over `Pending`.

## Sources of truth

In priority order:

- **AGENTS.md** — minimal operational invariants for running the project. CLAUDE.md is a symlink to it. No roadmap content here.
- **docs/ROADMAP.md §3b** — canonical ticket pool. Status, Priority, Phase, Scope, AC live in one row per ticket.
- **docs/PLAN.md** — strategic context. Read only the section that matches the ticket; cite which one in the plan.
- **packages/\*/src and apps/\*/src** — the actual code, the final source of truth when docs and code disagree.

When ROADMAP and PLAN disagree on Status, ROADMAP wins. When AGENTS.md and PLAN disagree on operational invariant, AGENTS.md wins. README.md is descriptive only — never a planning source.

## Workflow at a glance

PHASE 1:

1. Call EnterPlanMode.
2. Pick a ticket from §3b (or honor the user-named ENG-NNN).
3. Read the ticket row, the touched code paths, and the relevant `docs/PLAN.md` section if any.
4. Write the plan to chat AND to `~/.claude/plans/<slug>.md` (the file the Plan UI reads).
5. Call ExitPlanMode. The UI shows Accept/Reject. Stop.

After Accept (or after textual feedback on Reject), PHASE 2:

6. First line: `Executing ENG-NNN — <one-liner>`.
7. Implement the ticket: code + tests + doc-sync + collateral fixes, all in one cohesive working tree.
8. Doc-sync: flip Status in `docs/ROADMAP.md` §3b, update `docs/PLAN.md` only if a claim drifted, touch AGENTS.md only when an invariant changed, touch README.md only for descriptive facts.
9. Run gates: `bash .agents/skills/janus-ship/scripts/run-gates.sh` (add `--e2e` when user-facing). The script runs `pnpm build` + `pnpm test` (+ optional `pnpm test:e2e`), captures PASS/FAIL with timing, and tails the failing log when something breaks. Then run `typescript-react-reviewer` + `node` review skills in parallel on the unstaged diff.
10. Bring Compose down if it was started during the work.
11. `git add <explicit paths>` — ticket files + doc-sync + collaterals only.
12. Print the final report and the Conventional Commits suggestion.

For the full step-by-step of each phase, see [`references/phase-1-plan.md`](references/phase-1-plan.md) and [`references/phase-2-execute.md`](references/phase-2-execute.md).

## Hard rules

These never bend, in either phase:

- **Git:** only `git add <paths>` is mutating. Everything else is read-only. Full list in [`references/git-policy.md`](references/git-policy.md).
- **No AI co-authorship in commit messages.** No `Co-Authored-By: Claude`, no "Generated with Claude Code", no watermarks of any kind.
- **Multi-tenant scope:** every new query carries `eq(<table>.orgId, auth.orgId)`. No bespoke middleware.
- **AI fallback contract:** every OpenAI call wrapped in try/catch; failure returns `{ mode: "fallback", aiError, ... }`; `parseAiWorkflow` looser stays.
- **Engine atomicity:** no non-atomic `markNodeQueued`, no split `startRun`, no DLQ adapter bypass, worker `SIGTERM`/`SIGINT` handler intact.
- **OTel `service.name === "janusly"`** in tracer and meter.
- **Cross-panel reactivity:** mutations that invalidate server data call `bumpPlatformVersion()`.
- **Pagination cap 100/200** on `/runs` and `/workflows`; new list endpoints follow the pattern.
- **API routing (Open/Closed):** new HTTP routes plug into `routes: Route[]` in `apps/api/src/index.ts` via `routes.push({...})`. No inline `if (req.method === ...)` branches outside the dispatcher; `requireAuth` + `requireRole` are declared on the route entry, not called inside the handler.
- **Web deps lockdown:** `apps/web` imports stay within `react`, `react-dom`, `@xyflow/react`, `@supabase/supabase-js`, `zustand`, `lucide-react`. No radix, cva, clsx, tailwind-merge, shadcn scaffolding.
- **Tailwind 4 CSS-first:** no `tailwind.config.ts`, no `postcss.config.js`, no inline hex.
- **Vite 8:** `manualChunks` is a function.
- **Zod 4:** two-arg `z.record(z.string(), z.unknown())`.
- **HTTP/SSRF:** `ALLOW_PRIVATE_HTTP_TARGETS=false` not loosened.
- **Banned deps:** no tRPC, no Stripe SDK.
- **Compose lifecycle:** when started, bring down before final stage.
- **Symlink:** edit `AGENTS.md`, never break the `CLAUDE.md → AGENTS.md` symlink.
- **No ticket / roadmap refs in source code.** This repo is intended to go open source — readers won't have access to `docs/ROADMAP.md` or `docs/PLAN.md`. Source files (`packages/**/src`, `apps/**/src`, migrations, tests) must NOT mention `ENG-NNN`, "Phase 1/2/3", "Layer 1/2", roadmap section numbers (`§9`, `§3b`), or other planning artifacts. Comments in code explain the **what** and **why** in self-contained terms; if invariant motivation matters, copy it inline rather than linking out. The same rule applies to commit messages and JSDoc — the audit trail in chat / `docs/ROADMAP.md` is enough; source code stays clean. ROADMAP / PLAN / AGENTS / commit-message-summary fields ARE allowed to reference ticket ids (those docs are project-management surfaces, not the open-source code).

The full invariant catalogue is in [`references/invariants.md`](references/invariants.md).

## Collateral fixes

When a real bug surfaces in code unrelated to the ticket, fix it inline without asking. List every fix in the report's "Prerequisite fixes" section and as a `- collateral: ...` bullet at the end of the commit message body. The full classifier (what to fix vs what to skip vs what to STOP for) is in [`references/fix-policy.md`](references/fix-policy.md).

## Doc-sync

After the code lands and gates pass, before the final stage:

- `docs/ROADMAP.md` §3b — flip Status with a 2-3 line summary at the end of the Scope cell. Required for every ticket.
- `docs/PLAN.md` — only when a strategic claim drifted. Append `### §X.0 Status Update` inline.
- `AGENTS.md` — only when a new operational invariant landed.
- `README.md` — only when a descriptive fact (commands, stack, architecture) went stale.

When a new requirement without AC came up during the work (a feature gap, not a bug), add a new row to `docs/ROADMAP.md` §3b with `Status: Pending`. Bugs are fixed inline and never recorded as tickets.

## Final report and commit

The PHASE 2 report goes in chat at the end, in the order: Index state → Verification notes → Review Guide → Commit message summary. The full template lives in [`references/report-template.md`](references/report-template.md). Conventional Commits style rules (no AI co-authorship, hyphen bullets, scope by workspace, collateral bullets at the bottom) are in [`references/commit-style.md`](references/commit-style.md).

## Smoke seed

Janusly does not have a DEV-SEED.md. Dev mode auth uses headers `x-org-id: default` and `x-user-id: dev-user` (the web sends them automatically; for curl, set them explicitly). Production uses Supabase JWT — never invent credentials.

## Additional resources

### References

Detailed procedural knowledge (load when the corresponding step needs it):

- **`references/phase-1-plan.md`** — full PHASE 1 ticket selection and plan structure.
- **`references/phase-2-execute.md`** — full PHASE 2 execution, gates, staging, failure handling.
- **`references/git-policy.md`** — what git commands are allowed, what are forbidden, the rationale.
- **`references/fix-policy.md`** — collateral fix classifier (fix inline / skip / STOP and report).
- **`references/invariants.md`** — full Janusly invariant catalogue with surfaces and risks.
- **`references/commit-style.md`** — Conventional Commits style for the suggested message.
- **`references/report-template.md`** — section-by-section template for the final report.

### Examples

Concrete worked examples to pattern-match against:

- **`examples/plan-example.md`** — a complete PHASE 1 plan output for ENG-008 (Drizzle migrations, a `Partial` ticket).
- **`examples/report-example.md`** — a complete PHASE 2 final report for the same ticket, including a collateral fix.

### Scripts

- **`scripts/run-gates.sh`** — single command that runs `pnpm build`, `pnpm test`, and optionally `pnpm test:e2e` (with `--e2e`), prints a markdown gate summary, and exits non-zero on any failure. Use this in PHASE 2 step 9 instead of running the three commands separately. The structured output paste-fits into the Verification notes section of the final report.

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
5. **Before calling ExitPlanMode, end both the chat message AND the plan file with a Spanish plain-language explanation of the ticket** under a heading like `## Explicación en plano (qué hace el ticket y por qué)`. The user requested this convention as a permanent rule: every plan proposal must include the explanation pre-emptively, NOT the literal question text `¿Explícame el ticket? No lo entiendo.` — that question was once the prompt; the convention evolved to answering it up front. Write the explanation as if responding to "explícame el ticket": the underlying problem, the proposed solution in non-technical terms, the user-visible behavior changes, intentional breakage / migration risks, and the surface-level scope (which files / components are touched). Apply to every ticket proposal, in fresh proposals and re-plans after textual rejection feedback.
6. Call ExitPlanMode. The UI shows Accept/Reject. Stop.

After Accept (or after textual feedback on Reject), PHASE 2:

7. First line: `Executing ENG-NNN — <one-liner>`.
8. Implement the ticket: code + tests + doc-sync + collateral fixes, all in one cohesive working tree.
9. Doc-sync: flip Status in `docs/ROADMAP.md` §3b, update `docs/PLAN.md` only if a claim drifted, touch AGENTS.md only when an invariant changed, touch README.md only for descriptive facts.
10. Run gates: `bash .claude/skills/janus-ship/scripts/run-gates.sh` (add `--e2e` when user-facing). The script runs `pnpm build` + `pnpm test` (+ optional `pnpm test:e2e`), captures PASS/FAIL with timing, and tails the failing log when something breaks. Then run the review skills on the unstaged diff. **Review skill dispatch is contract, not preference:** invoke `typescript-react-reviewer` via the `Skill` tool (NOT the `Agent` tool) whenever the diff touches `apps/web/**` — this loads the React 19 / TS / Zustand / Vite 8 / Tailwind 4 review rubric into THIS conversation so the review runs with the same context the implementer already has. Invoke `node` via the `Skill` tool for any diff touching `apps/api/**`, `packages/engine/**`, `packages/ai/**`, `packages/data/**`, `packages/db/**`, `scripts/**`, or `vite*.config.*`. Both skills MUST run when both surfaces are touched. The `feature-dev:code-reviewer` agent is ADDITIVE — useful when an independent loop without implementer-bias is worth the parallel cost — but NEVER a substitute. Substituting the agent for the skill (because the skill name "sounds like" a `subagent_type`) is non-compliance with the workflow.
11. Bring Compose down if it was started during the work.
12. `git add <explicit paths>` — ticket files + doc-sync + collaterals only.
13. Print the final report and the Conventional Commits suggestion.

For the full step-by-step of each phase, see [`references/phase-1-plan.md`](references/phase-1-plan.md) and [`references/phase-2-execute.md`](references/phase-2-execute.md).

## Hard rules

These never bend, in either phase:

- **Git:** only `git add <paths>` is mutating. Everything else is read-only. Full list in [`references/git-policy.md`](references/git-policy.md).
- **No AI co-authorship in commit messages.** No `Co-Authored-By: Claude`, no "Generated with Claude Code", no watermarks of any kind.
- **Review skill dispatch is mandatory and tool-specific.** When the diff touches `apps/web/**`, the `typescript-react-reviewer` skill MUST run via the `Skill` tool (`Skill({ skill: "typescript-react-reviewer", args: "..." })`) — not via the `Agent` tool. The skill loads the React 19 / TS / Zustand / Vite 8 / Tailwind 4 rubric into THIS turn so the review applies with full implementer context. Same posture for `node` on backend-touching diffs (`apps/api/**`, `packages/engine/**`, `packages/ai/**`, `packages/data/**`, `packages/db/**`, `scripts/**`, `vite*.config.*`). Both skills MUST run when both surfaces are touched. The `feature-dev:code-reviewer` agent is ADDITIVE — useful for an independent loop without implementer-bias — but NEVER a substitute. If the `Skill` tool fails for a real reason (skill genuinely not installed, args malformed), STOP and surface that to the user instead of silently swapping in the agent. This rule fires in BOTH PHASE 2 reviewer steps of `/janus-ship` AND every reviewer step of `/janus-review`.
- **i18n coverage:** new or changed user-facing text in `apps/web/**` must go through `useT()` / `t()` exported from `apps/web/src/i18n` — never raw string literals in JSX, `aria-label`, `placeholder`, `title`, `alt`, or in the first argument of `addToast(...)`. Every new key in `en/common.json` requires its sibling in `es/common.json` (gated by `apps/web/src/i18n/parity.test.ts`). Strings emitted from the server with a stable `code` go through the dedicated helpers (`tValidationIssue` / `tReadinessIssue` / `tAiReviewIssue` / `tRunEvent` / `tFailureCluster`) and gain a `<surface>.<code>` entry in the catalog when the engine adds a new code; free-form server messages flow through `t('serverEvents.fallback', { message })`. Components MUST NOT import from `i18next` / `react-i18next` directly — every consumer is the i18n module. Exempt: technical identifiers (`'dev-user'`, role tokens like `'admin'` when stored as values, tool names like `'slack.post'`), brand-mark codes (`'JN'`, `'Janusly'`), single-punctuation / emoji-only nodes, test files, console / log messages, and backend `error.message` strings passed through unmodified. Spot scan: `bash .claude/skills/janus-ship/scripts/check-i18n-coverage.sh` (a symlink to `apps/web/scripts/check-i18n-coverage.sh`) reports suspect literals against `git diff --cached`.
- **UI smoke is focused, overlay-free, and state-by-state.** When the diff renders anything in `apps/web/**`, the real-browser smoke MUST validate the ticket's OWN surface, not the app shell. Follow [`references/ui-smoke.md`](references/ui-smoke.md): (1) screenshot the changed element by ref/selector — a `fullPage` frame of the app is NOT acceptable evidence; (2) hide unrelated overlays (onboarding banner, toasts, budget banner, command palette) BEFORE capturing so they never obstruct the surface; (3) capture EACH state the change introduces (default / interacted / loading / result / empty / error) as its own PNG; (4) prove every frame actually shows the change via a `browser_snapshot` / DOM probe before saving; (5) name `web-<locale>-<surface>-<state>.png`, seed real ticket data, both locales when copy changed, console 0 errors. A generic or overlay-covered screenshot is a verification failure — retake it.
- **Multi-tenant scope:** every new query carries `eq(<table>.orgId, auth.orgId)`. No bespoke middleware.
- **AI fallback contract:** every OpenAI call wrapped in try/catch; failure returns `{ mode: "fallback", aiError, ... }`; `parseAiWorkflow` looser stays.
- **Engine atomicity:** no non-atomic `markNodeQueued`, no split `startRun`, no DLQ adapter bypass, worker `SIGTERM`/`SIGINT` handler intact.
- **OTel `service.name === "janusly"`** in tracer and meter.
- **Cross-panel reactivity:** mutations that invalidate server data call `bumpPlatformVersion()`.
- **Pagination cap 100/200** on `/runs` and `/workflows`; new list endpoints follow the pattern.
- **API routing (Open/Closed):** new HTTP routes plug into `routes: Route[]` in `apps/api/src/index.ts` via `routes.push({...})`. No inline `if (req.method === ...)` branches outside the dispatcher; `requireAuth` + `requireRole` are declared on the route entry, not called inside the handler.
- **Web deps lockdown:** `apps/web` imports stay within `react`, `react-dom`, `@xyflow/react`, `@supabase/supabase-js`, `zustand`, `lucide-react`, `i18next`, `react-i18next`. The two i18n libs are restricted to the `apps/web/src/i18n/` module — components NEVER import from `i18next` / `react-i18next` directly. No radix, cva, clsx, tailwind-merge, shadcn scaffolding.
- **Tailwind 4 CSS-first:** no `tailwind.config.ts`, no `postcss.config.js`, no inline hex.
- **Vite 8:** `manualChunks` is a function.
- **Zod 4:** two-arg `z.record(z.string(), z.unknown())`.
- **HTTP/SSRF:** `ALLOW_PRIVATE_HTTP_TARGETS=false` not loosened.
- **Banned deps:** no tRPC, no Stripe SDK.
- **Compose lifecycle:** when started, bring down before final stage.
- **Verification artifacts land in `output/`, never in `/tmp`.** Throwaway files created during PHASE 2 verification — psql seed scripts, EXPLAIN ANALYZE captures, JS-reference comparison snippets, tsx integration verifiers, curl response captures, `tail -n` log dumps — go under `output/janus-ship/eng-NNN/` (a per-ticket folder; create on demand). NOT under `/tmp`. `output/` is already in `.gitignore` so the repo stays clean, but the files persist across reboots, are visible in the editor's file tree, and the human reviewer can read them without remembering paths. Use short filenames (`smoke.sql`, `live-verify.ts`, `output.txt`) — the `eng-NNN/` prefix already disambiguates. **Do NOT delete** any of these files at the end of the turn; the human deletes them. The same applies to Playwright e2e dumps under `test-results/` / `playwright-report/`, browser screenshots taken via the Playwright MCP tools under `.playwright-mcp/`, or any image saved during a manual smoke — leave them in place. Do not run any "tidy up" helper that would prune those paths. If a file truly needs to be removed (e.g. it contains a real secret that leaked from the dev env), STOP and flag it to the user instead of deleting silently.
- **Symlink:** edit `AGENTS.md`, never break the `CLAUDE.md → AGENTS.md` symlink.
- **No ticket / roadmap refs in source code.** This repo is intended to go open source — readers won't have access to `docs/ROADMAP.md` or `docs/PLAN.md`. Source files (`packages/**/src`, `apps/**/src`, migrations, tests) must NOT mention `ENG-NNN`, "Phase 1/2/3", "Layer 1/2", roadmap section numbers (`§9`, `§3b`), or other planning artifacts. Comments in code explain the **what** and **why** in self-contained terms; if invariant motivation matters, copy it inline rather than linking out. The same rule applies to commit messages and JSDoc — the audit trail in chat / `docs/ROADMAP.md` is enough; source code stays clean. ROADMAP / PLAN / AGENTS / commit-message-summary fields ARE allowed to reference ticket ids (those docs are project-management surfaces, not the open-source code).
- **Document new TypeScript types:** when a slice introduces a new `interface`, `type`, `enum`, or non-trivial type alias, add an internal JSDoc / TSDoc comment above it — what it models, why it exists, plus any constraints / invariants / units / nullability or non-obvious field semantics worth calling out. Keeps maintainability, IntelliSense, and logic legible. Self-contained prose only — no `ENG-NNN` / roadmap refs in the JSDoc, per the rule above. Trivial one-off local aliases are exempt; anything exported or encoding a domain rule is not.

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

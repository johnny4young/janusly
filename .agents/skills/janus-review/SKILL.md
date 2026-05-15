---
name: janus-review
description: Use in the Janusly repository when the user asks to review, audit, sanity-check, double-check, or run a pre-commit review of staged changes. Trigger on phrases like "review the staged diff", "what's staged", "audit before commit", "check the index", "review the implementer's work", "second pair of eyes", "double-check before I push", or "janus-review". The skill audits `git diff --cached` against AGENTS.md, the roadmap/plan, and Janusly invariants; runs gates; fixes real observable bugs inline as unstaged working-tree changes; reports design/scope/security blockers without mutating git; and ends with one Conventional Commits suggestion.
---

# janus-review — Pre-commit review for Janusly

This skill audits the current staging before the human commits. It complements `janus-ship`: where `janus-ship` produces a clean staging, `janus-review` audits it without touching the index.

The output is two physically separated buckets:

- **staged** = the implementer's work, untouched.
- **unstaged** = the reviewer's inline fixes for real bugs found during audit.

The human then runs `git diff --cached` vs `git diff` in their IDE, decides what enters the commit, and runs `git commit` themselves. The reviewer never commits, never stages, never resets, never touches mutating git.

## When to use

Trigger on any of these phrases or close paraphrases:

- "Review the staged diff / what's staged"
- "Audit before I commit"
- "Pre-commit review"
- "Sanity-check this branch / these changes"
- "Review the implementer's work"
- "Run janus-review on this"

This skill assumes the user has run `git add` (typically via `janus-ship` PHASE 2 or by hand). When `git diff --cached` is empty, report that immediately and exit — there is nothing to review.

## Mode of operation

Act as an external reviewer, not a second implementer. The implementer has business and design context the reviewer does not have:

- **Real bugs:** fix inline in the working tree (unstaged). Every fix lands in the report under "Bugs fixed inline".
- **Design changes, AC ambiguity, security questions:** REPORT, do not fix. Wait for human input.
- **Out-of-scope features without AC:** add a new `Pending` row to `docs/ROADMAP.md` §3b. Bugs go to fixes; tickets go to ROADMAP.

The full classifier is in [`references/fix-policy.md`](references/fix-policy.md).

## Workflow at a glance

1. **Orient.** Read `git status`, `git diff --cached --stat`, `.git/COMMIT_EDITMSG` if present. Identify the ENG-NNN the diff claims to attack. Validate against `docs/ROADMAP.md` §3b: does the ticket exist, was Status `Pending`/`Partial` before, does the diff scope fit?
2. **Align against the approved plan.** When a plan from `janus-ship` PHASE 1 is in the chat, compare. Files outside the plan are scope creep (report). Missing files the plan flagged required (test, doc, sync entry) are findings (report).
3. **Run cheap gates.** `bash .agents/skills/janus-review/scripts/run-gates.sh` (add `--e2e` only when the diff touches end-to-end user-facing surface). The script wraps `pnpm build` + `pnpm test` (+ optional `pnpm test:e2e`) into a single PASS/FAIL summary that paste-fits into the report's Gates section. When `--e2e` runs, guarantee `docker compose down` at the end.
4. **Run review skills in parallel** on the staged diff:
   - `typescript-react-reviewer` for `apps/web/**`.
   - `node` for `apps/api/**`, `packages/engine/**`, `packages/ai/**`, `packages/data/**`, `packages/db/**`, `scripts/**`, `vite*.config.*`.
5. **Run Janusly-specific checks** for the surfaces the diff touched. The full catalogue (multi-tenant, AI fallback, engine atomicity, audit logs, cross-panel reactivity, pagination, web deps, Tailwind, Vite, Zod, SSRF, tests, banned deps, doc sync) is in [`references/janusly-checks.md`](references/janusly-checks.md).
6. **Smoke** when the diff is user-facing. Bring up Compose + api + worker + web with dev headers `x-org-id: default` / `x-user-id: dev-user`, exercise happy path + one error path, verify `mode: "ai"` / `mode: "fallback"` for AI surfaces, tear Compose down at the end.
7. **Print the report** in the chat, following the section order in [`references/report-template.md`](references/report-template.md). End with a single Conventional Commits message that covers staged + unstaged together.

## Sources of truth

In priority order:

- **AGENTS.md** — minimal operational invariants. CLAUDE.md is a symlink to it. Never planning content.
- **docs/ROADMAP.md §3b** — ticket Status, Priority, AC. Verify the implementer's Status flip is consistent with the diff.
- **docs/PLAN.md** — load only the section that matches the ticket (grep for ENG-NNN). Never load the full file.
- **README.md** — descriptive only. When the implementer leaked planning into README, fix inline by moving content to ROADMAP.
- **Conversation chat** — when a `janus-ship` plan is present, the staged diff MUST correspond to it.

When ROADMAP and PLAN disagree on Status, ROADMAP wins. When AGENTS.md and PLAN disagree on operational, AGENTS.md wins.

## Hard rules

- **Git:** zero mutating commands. Inline fixes via Edit/Write land in working tree (unstaged) automatically. Full list in [`references/git-policy.md`](references/git-policy.md).
- **Closing rule:** finish the report and stop. No closing step touches git.
- **Single bucket for fixes:** every real-bug fix goes under "Bugs fixed inline" in the report. No severity split.
- **Two buckets for findings:** real bugs are fixed; design / AC / security questions are reported under "Design / scope findings — NOT fixed".
- **No AI co-authorship in the suggested commit.** No `Co-Authored-By: Claude`, no "Generated with Claude Code", no watermarks.
- **One commit, one story.** The suggested message covers staged + unstaged together. Do not offer a split version.
- **Smoke seed:** dev mode auth uses `x-org-id: default` / `x-user-id: dev-user`. Production uses Supabase JWT. Never invent credentials.

## Janusly-specific check overview

The generic review skills do not know about Janusly's conventions. Run through the relevant checks based on what the diff touched:

- **a. Multi-tenant** — every new query carries `eq(<table>.orgId, auth.orgId)`.
- **b. AI fallback** — try/catch + `{ mode, aiError }` contract intact; `parseAiWorkflow` looser kept.
- **c. Engine atomicity** — `tryClaimNodeForQueue` atomic; `startRun` one transaction; DLQ adapter not bypassed; worker `worker.close()` on SIGTERM/SIGINT.
- **d. Audit logs** — every mutation writes a row with a stable `action`. AI mutations write audit on success AND fallback.
- **e. Cross-panel reactivity** — mutations call `bumpPlatformVersion()` so independent panels refetch.
- **f. Pagination** — list endpoints cap 100/200.
- **g. Web deps lockdown** — `apps/web` imports stay within the whitelist.
- **h. Tailwind 4 CSS-first** — no config files, tokens via `--color-we-*`, no inline hex.
- **i. Vite 8** — `manualChunks` is a function.
- **j. Zod 4** — two-arg `z.record(z.string(), z.unknown())`.
- **k. HTTP/SSRF** — `ALLOW_PRIVATE_HTTP_TARGETS=false` not loosened.
- **l. Tests** — edge cases for helpers, AI success+fallback, audit row asserted.
- **m. Banned deps** — no tRPC, no Stripe SDK.
- **n. Doc sync** — ROADMAP §3b Status flip applied; PLAN updated only when claims drifted; AGENTS only when invariant changed; README without leaked planning.
- **o. API routing (Open/Closed)** — new HTTP routes register in the `routes: Route[]` array exported from `apps/api/src/index.ts`; no inline `if (req.method === ...)` branches outside the dispatcher; `requireAuth` + `requireRole` declared on the route entry, not in the handler body.
- **p. No ticket / roadmap refs in source code** — staged source files under `packages/**/src` and `apps/**/src` (incl. tests, migrations) must not contain `ENG-NNN` / `Phase N` / `Layer N` / `§N` references. ROADMAP / PLAN / AGENTS / report / commit-message-summary may keep them.
- **q. i18n coverage** — user-facing text added or changed under `apps/web/**` is wrapped via `useT()` / `t()` from `apps/web/src/i18n` (no raw literals in JSX, `aria-label`, `placeholder`, `title`, `alt`, or the first arg of `addToast(...)`). Every new key in `en/common.json` has its sibling in `es/common.json` (gated by `apps/web/src/i18n/parity.test.ts`). Server-emitted strings with a stable `code` use the surface-specific helpers (`tValidationIssue` / `tReadinessIssue` / `tAiReviewIssue` / `tRunEvent` / `tFailureCluster`); free-form goes through `t('serverEvents.fallback', { message })`. Components MUST NOT import from `i18next` / `react-i18next` directly — everything routes through the i18n module. Exemptions and full action policy in [`references/janusly-checks.md`](references/janusly-checks.md).

For each check, the action when a violation is found (FIX INLINE vs REPORT) is in [`references/janusly-checks.md`](references/janusly-checks.md).

## Final report

The report ends the turn. Print sections in this order: verdict → gates → bugs fixed inline → design findings → out-of-scope requirements → doc-sync checklist → commit message → how-you-continue. The full template is in [`references/report-template.md`](references/report-template.md), with a worked example in [`examples/report-example.md`](examples/report-example.md).

## Additional resources

### References

Detailed procedural knowledge (load when the corresponding step needs it):

- **`references/git-policy.md`** — exact list of allowed and forbidden git commands plus the rationale for the staged/unstaged split.
- **`references/fix-policy.md`** — full classifier: what to fix inline, what to skip, what to report instead of fix.
- **`references/janusly-checks.md`** — every Janusly-specific check (a-n) with the surfaces, the invariant, and the FIX INLINE vs REPORT action.
- **`references/report-template.md`** — section-by-section template for the final report and commit message.

### Examples

- **`examples/report-example.md`** — complete review report for ENG-008 (Drizzle migrations), including two inline fixes, one design finding, and a cross-reference update to ENG-015 in `docs/ROADMAP.md`.

### Scripts

- **`scripts/run-gates.sh`** — runs `pnpm build`, `pnpm test`, and optionally `pnpm test:e2e` (with `--e2e`), prints a markdown gate summary with PASS/FAIL and timing, and exits non-zero on any failure. Use this in step 3 of the workflow. The output paste-fits into the Gates section of the report.

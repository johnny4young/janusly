# Inline-fix policy — janus-review

Priority: excellent product, codebase with no debt. Every observable real bug is fixed inline. No line or file threshold. No asking. The fixes land in the working tree (unstaged) so the human sees them in `git diff` alongside the implementer's `git diff --cached`.

Every inline fix lands in the report under "Bugs fixed inline" with file:line + what was broken + what fixes it. Single bucket; no severity split.

## Fix inline (no exception)

- Typo, broken import order, import to a renamed or moved file.
- Stale path / reference to a deleted module.
- Out-of-sync config (`.env.example`, `tsconfig.base.json`, drizzle config, `pnpm-workspace.yaml`).
- Broken test, skipped for an unrelated reason, or with a weak assertion — fix the root cause, NEVER delete the test or weaken the assertion.
- Type debt: leaked `any`, mis-propagated `never`, stale enum, broken generic, single-arg `z.record(x)` instead of two-arg `z.record(z.string(), x)`.
- Schema shim or mirror out of sync with `packages/db/src/schema.ts`.
- Comment that describes behavior already removed.
- Observably wrong behavior in code adjacent to the diff.
- Orphan deps in `package.json` that the diff does not use.
- Inline hex in components — replace with `var(--color-we-*)`.
- Illegal imports in `apps/web` (`@radix-ui/*`, `class-variance-authority`, `clsx`, `tailwind-merge`, anything not in the AGENTS.md whitelist). Rewrite with CSS-first Tailwind 4.
- AI surface broken: try/catch removed, `aiError` not surfaced, `parseAiWorkflow` looser gone, `{ mode, aiError }` contract changed.
- Engine regressions: non-atomic `markNodeQueued` re-introduced, `startRun` split into separate inserts, DLQ adapter bypassed.
- React 19 + Zustand pitfalls: non-pure read during render (`Date.now()`, `Math.random()`), persist without `partialize`, useEffect deps with new literals each render.
- Pagination cap 100/200 removed on `/runs` or `/workflows`.
- `bumpPlatformVersion()` missing after a mutation that should fan out.
- Audit log row missing on a new mutation.
- Multi-tenant gap: new query without `eq(<table>.orgId, auth.orgId)`.
- SSRF: `http` node or `http.request` tool that does not respect `ALLOW_PRIVATE_HTTP_TARGETS`.

## Do NOT fix

- Style, naming, or structural refactors driven by aesthetic opinion.
- File reorganization without an observable bug.
- Performance changes without a concrete profile.
- "I'd like this function to have a different signature" — that is a design call.

## REPORT instead of fixing

Some findings need human input. Report under "Design / scope findings — NOT fixed" and stop touching that area:

- Design change that affects the ticket approach.
- Implementer scope creep (files outside the approved plan).
- Ambiguity in the ticket AC that changes interpretation.
- Security or privacy issue:
  - RLS gap (missing `org_id` in a query).
  - Loosened SSRF check.
  - Secret leak in logs.
  - Bypass of the prod auth refusal (`ALLOW_DEV_AUTH_HEADERS=true` set in production without justification).
  - Prompt injection on AI surface.
- Incidental concerns mixed with scope where separating fix from feature is risky.

## New requirements without AC

When a missing feature surfaces that is outside the ticket scope, write a new row in `docs/ROADMAP.md` §3b with `Status: Pending` and AC to fill in. The new row is a doc edit and shows up in the unstaged bucket like any other inline fix. List it in the report under "Out-of-scope requirements → docs/ROADMAP.md §3b".

Bugs go to the inline fix list. Tickets go to ROADMAP. Never confuse the two.

## When the implementer's doc-sync is missing

When the implementer forgot a required doc-sync edit (most commonly the `docs/ROADMAP.md` §3b Status flip), apply the doc edit inline like any other fix. List it under "Bugs fixed inline" with a note that it was a doc-sync oversight.

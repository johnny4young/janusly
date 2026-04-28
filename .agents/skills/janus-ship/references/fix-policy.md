# Collateral-fix policy — janus-ship

Operational priority: a codebase with no visible debt. When PHASE 2 hits a real bug in code unrelated to the active ticket, fix it inline without asking. No line or file threshold.

Every collateral fix lands in:

- The "Prerequisite fixes" section of the Review Guide (file:line + what was broken + how it was fixed).
- The commit message body as `- collateral: ...` bullets at the end.

## Fix inline (no asking)

- Stale path / reference to a moved or deleted file / broken import.
- Out-of-sync config: `.env.example` with a removed var, `tsconfig.base.json` with a non-existent path alias, drizzle config pointing at a moved schema, `pnpm-workspace.yaml` mismatch.
- Skipped or broken test for a reason unrelated to the ticket — un-skip or fix the root cause. Never delete or weaken.
- Type debt: leaked `any`, mis-propagated `never`, stale enum, broken generic, single-arg `z.record(x)` instead of two-arg `z.record(z.string(), x)`.
- Schema shim or mirror out of sync with `packages/db/src/schema.ts`.
- Comment that describes behavior already removed.
- Observably wrong behavior in adjacent code touched by the ticket.
- Orphan deps in `apps/*/package.json` or `packages/*/package.json` that the diff does not use.
- Inline hex in `apps/web` components — replace with `var(--color-we-*)`.
- Illegal imports in `apps/web`: `@radix-ui/*`, `class-variance-authority`, `clsx`, `tailwind-merge`, or any dep not listed in AGENTS.md. Rewrite with CSS-first Tailwind 4.
- AI fallback broken: try/catch removed, `aiError` not surfaced, `parseAiWorkflow` looser gone, `{ mode, aiError }` contract changed.
- Pagination cap 100/200 removed without explanation on `/runs` or `/workflows`.
- `bumpPlatformVersion()` missing after a mutation that should fan out to other panels.
- Missing audit row on a new mutation.
- Multi-tenant gap: new query without `eq(<table>.orgId, auth.orgId)`.
- SSRF: `http` node or `http.request` tool that does not respect `ALLOW_PRIVATE_HTTP_TARGETS`.

## Do NOT touch inline

- Style, naming, or structural refactors driven by opinion.
- File reorganization without an observable bug.
- "I'd like this to be different" rewrites — those are features, not fixes.
- Performance changes without a concrete profile.

## STOP and report instead of fixing

When any of these surface, do not modify the code. Report in the chat and wait for input:

- Design change: the approach approved in PHASE 1 no longer holds.
- Ambiguity in the ticket AC that changes the interpretation.
- Security or privacy concern: SSRF, secret leak in logs, RLS gap from a missing `org_id`, bypass of the prod auth refusal, prompt injection on AI surface.
- Incidental concerns mixed with the ticket scope where separating fix from feature would be risky.

## New requirements without AC

When a missing requirement is spotted (not a bug — a feature gap), add a new row to `docs/ROADMAP.md` §3b with `Status: Pending` and acceptance criteria to be filled in. Bugs are fixed inline and never recorded as tickets.

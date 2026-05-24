# PHASE 2 — Execute (detailed)

PHASE 2 begins only after the user clicks Accept on the Plan panel UI (a system message confirms it). The deliverable is a single coherent staging that includes ticket code + tests + doc-sync + collateral fixes, plus a final report and a suggested commit message.

## Step 1 — Announce execution

First line of the post-Accept turn:

    Executing ENG-NNN — <one-liner>

This signals the transition out of plan mode and into implementation.

## Step 2 — Implement the ticket

Implement against the approved plan. Group all the work — code, tests, doc-sync, collateral fixes — into a single cohesive staging. Do not split into multiple separate stagings.

Apply [`fix-policy.md`](fix-policy.md) for collateral fixes encountered along the way.

## Step 3 — Doc-sync

Run doc-sync BEFORE the final stage. The doc edits land in the same diff as the code.

### docs/ROADMAP.md §3b

Required for every ticket close. Flip the row's `Status`:

- `Partial` → `Shipped` when the work closes the ticket entirely.
- `Pending` → `Shipped` when the entire scope landed.
- `Pending` → `Partial` when only a slice landed; update the Scope cell with a `Remaining:` line listing what is left.

Append a 2-3 line `**Summary:**` to the end of the Scope cell describing what shipped. Use the existing ENG-NNN row patterns as the template.

### docs/PLAN.md

Optional. Only edit when the ticket made claims in some section fall stale. Append `### §X.0 Status Update` inline at the end of the affected section (do not rewrite the original body).

### AGENTS.md

Optional. Only edit when the ticket introduced or changed an operational invariant — for example, a new critical env var, a new engine invariant, or a new workspace. Do NOT add roadmap content. Do NOT break the `CLAUDE.md → AGENTS.md` symlink.

### README.md

Optional. Only edit when:

- A quick-start command changed.
- A descriptive fact (stack version, package list, architecture diagram) went stale.

Do NOT add planning, status, or "what's next" content to README. That goes in `docs/ROADMAP.md` exclusively.

### New requirements without AC

When the ticket surfaced a missing feature (not a bug), add a new row to `docs/ROADMAP.md` §3b with `Status: Pending` and AC to fill in. Bugs are fixed inline, not recorded as tickets.

## Step 4 — Run gates

Run all gates BEFORE staging. Every gate must be green. In order:

1. `pnpm build` — tsc --noEmit on api/db/data + Vite production build on web.
2. `pnpm test` — Vitest 4 across shared, engine, ai, domain, web. Run from the repo root even when only one workspace was touched.
3. `pnpm test:e2e` — only when the ticket touches end-to-end user-facing surface (run lifecycle, AI Studio, save flow). When it does not apply, justify in the report.
4. Review skills in parallel on the still-unstaged diff (`git diff` without `--cached`):
   - `typescript-react-reviewer` for `apps/web/**`.
   - `node` for `apps/api/**`, `packages/engine/**`, `packages/ai/**`, `packages/data/**`, `packages/db/**`, `scripts/**`, `vite*.config.*`.

Resolve every HIGH finding inline. List MED findings as Follow-ups in the Review Guide; they do not block delivery.

## Step 5 — Failure handling

When a gate fails:

- Failure is from the ticket → fix in the same turn.
- Failure is from a collateral bug → fix inline per [`fix-policy.md`](fix-policy.md).
- Failure is from a design change, ambiguity, or security concern → STOP and report. Do not push through.

## Step 6 — Compose lifecycle

When `docker compose up` was started during the work (smoke or e2e), run `docker compose down` before final staging. Never leave containers running.

**Verification artifacts are NOT cleaned up.** Screenshots and logs the agent created during verification — Playwright e2e dumps in `test-results/` / `playwright-report/`, MCP browser screenshots in `.playwright-mcp/`, manual-smoke curl captures, `tail -n` log dumps written to disk — stay on disk until the human deletes them. The reviewer reads those files as part of the PR review to confirm the UI rendered as claimed. Compose teardown applies ONLY to running containers, not to the artifact directories.

## Step 7 — Final stage

Stage explicitly, never `git add -A` or `git add .`:

    git add <ticket files>
    git add <doc-sync files>
    git add <collateral fix files>
    git diff --cached --stat

Read the stat output to confirm the staging matches the approved scope plus any collaterals. When something extra appears, redo the `git add` with corrected paths — do not run `git restore --staged`. See [`git-policy.md`](git-policy.md) for the full rules.

## Step 8 — Final report

Print the Review Guide in chat. The full template lives in [`report-template.md`](report-template.md). Use [`../examples/report-example.md`](../examples/report-example.md) as a worked example.

The report ends with a single Conventional Commits message that covers everything in the staging. Style rules in [`commit-style.md`](commit-style.md). The human commits manually.

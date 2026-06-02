# Final report template — janus-ship

Print the report in chat at the end of PHASE 2, in this exact section order. See [`../examples/report-example.md`](../examples/report-example.md) for a worked example.

## Section 1 — Index state

    ### Index state
    - <output of `git status --short`>
    - <output of `git diff --stat --cached`>

## Section 2 — Verification notes

    ### Verification notes
    - pnpm build: PASS / FAIL (detail on failure)
    - pnpm test: PASS / FAIL with test counts
    - pnpm test:e2e: ran / does not apply because <reason>
    - typescript-react-reviewer: <N findings; HIGH fixed inline, MED listed below>
    - node: <N findings; HIGH fixed inline, MED listed below>
    - Live smoke: ran / could not verify in this session because <reason>
    - Compose: brought up / not started / brought down at the end
    - Collateral fixes applied: <one per line, or "None">
    - ROADMAP §3b items captured: <new Pending rows added, or "None">
    - ROADMAP archive move: <ENG-NNN moved to §3c, left Partial in §3b, or "None">

## Section 3 — Review Guide

    ### Review Guide — ENG-NNN

    **1. Automated gates** (copy-pasteable)

        pnpm build
        pnpm test
        pnpm --filter @janusly/<workspace> test -- <test-file>

    Test files added or modified:
    - <path>
    - <path>

    **2. Prerequisite fixes** (every collateral applied)
    - <file>:<L> — what was broken + how it was fixed.

    Or: "None".

    **3. Live smoke**

    Bring-up:

        docker compose up -d redis postgres ollama
        pnpm --filter @janusly/api dev      # http://localhost:3001
        pnpm --filter @janusly/engine dev   # worker
        pnpm --filter @janusly/web dev      # http://localhost:5173

    Auth: dev mode sends `x-org-id: default` and `x-user-id: dev-user` automatically. For curl, same headers.

    Numbered steps:
    1. <action>
    2. <action>
    3. <expected outcome>

    Verification SQL (when relevant):

        psql postgres://postgres:postgres@localhost:5432/workflow -c "<query>"

    For AI surface tickets: confirm `mode: "ai"` with the key, `mode: "fallback"` without, and `mode: "fallback"` + `aiError` on a simulated failure.

    Teardown: `docker compose down`.

    Hard assertion: 0 errors in the web console; API logs free of ERROR.

    **4. Code review focus** (3-6 files, ordered by criticality)

    1. <path>:<L> — <invariant to verify>
    2. <path>:<L> — <invariant to verify>

    Cross-check invariants:
    - [ ] Multi-tenant: every new query scoped by `auth.orgId`
    - [ ] AI fallback: try/catch + `{ mode, aiError }` intact
    - [ ] Atomic claim `tryClaimNodeForQueue` not replaced
    - [ ] `startRun` is still a single Drizzle transaction
    - [ ] DLQ via `BullMQQueueAdapter` + `DeadLetterQueueAdapter` not bypassed
    - [ ] Worker `worker.close()` on SIGTERM/SIGINT preserved
    - [ ] OTel `service.name === "janusly"`
    - [ ] `bumpPlatformVersion()` after the right mutations
    - [ ] Pagination cap 100/200 on list endpoints
    - [ ] `apps/web` imports stay within the lockdown
    - [ ] No inline hex; `var(--color-we-*)` tokens
    - [ ] Vite `manualChunks` is still a function
    - [ ] Zod 4 two-arg `z.record(z.string(), z.unknown())`
    - [ ] `ALLOW_PRIVATE_HTTP_TARGETS=false` not loosened
    - [ ] Auth refusal in prod without Supabase preserved
    - [ ] No tRPC / Stripe re-introduced
    - [ ] Audit log row on every new mutation

    **5. Docs sync checklist**
    - [ ] `docs/ROADMAP.md` §3b/§3c updated: Shipped row archived, or Partial row left active with Remaining
    - [ ] `docs/PLAN.md` §X.0 Status Update added (when applicable)
    - [ ] AGENTS.md updated (only if an operational invariant changed; symlink intact)
    - [ ] `docs/ROADMAP.md` §3b: new Pending row created (when a new requirement without AC came up)

    **6. Quick rollback** (when rejecting)

        git restore --staged .
        git checkout .

    New files also disappear.

    **7. Deferred follow-ups** (not staged)
    - <MED finding 1>
    - <out-of-scope idea 2>

## Section 4 — Commit message summary

    ### Commit message summary

    feat(<scope>): <one-line>

    - <bullet>
    - <bullet>
    - collateral: <file>:<L> — <what + fix>

See [`commit-style.md`](commit-style.md) for the full style rules.

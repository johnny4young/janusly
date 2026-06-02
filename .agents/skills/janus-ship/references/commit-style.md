# Commit message style — janus-ship

The skill prints ONE Conventional Commits message at the end of PHASE 2. The human commits manually. The skill never runs `git commit`.

## One commit, one story

The single message covers the entire staging:

- Ticket code and tests.
- Doc-sync edits (`docs/ROADMAP.md`, `docs/PLAN.md`, AGENTS.md, README.md).
- Every collateral fix.

Do NOT offer a split version of the message. Splitting is the human's choice.

## Body rules

- No backticks in the body. No double quotes around code or paths.
- Hyphen bullets (`-`), one per line.
- One main subject line, then a blank line, then bullets.
- Scope by main workspace: `api`, `web`, `engine`, `ai`, `domain`, `data`, `db`, `shared`. Multiple lines in the body when the ticket crosses several.
- Collateral fixes go at the end as `- collateral: ...` bullets, one per fix.

## NO AI co-authorship

Never include any of:

- `Co-Authored-By: Claude` (or any model, any email)
- `Generated with Claude Code`
- Any "AI-assisted" or "made with Claude" trailer

This applies to every surface: the printed suggestion, any heredoc body, any rebase or amend message. The user's global preference excludes AI co-authorship by default.

## Template

    feat(<scope>): <one-line description of the ticket>

    - <main implementer change>
    - <secondary implementer change>
    - <test additions>
    - <doc sync: ROADMAP ENG-NNN moved from §3b to §3c as Shipped>
    - collateral: <file>:<L> — <what was broken + fix>
    - collateral: <file>:<L> — <what was broken + fix>

## Type and scope

- `feat`: new feature or capability.
- `fix`: bug fix.
- `refactor`: code change without behavior change.
- `chore`: tooling, deps, config.
- `docs`: doc-only ticket.
- `test`: test-only ticket.
- `perf`: performance improvement (with profile evidence).

Scope follows workspace boundaries:

- `feat(api): ...`
- `feat(web): ...`
- `feat(engine): ...`
- `fix(ai): ...`
- `chore(deps): ...`
- `feat(api,web): ...` for tickets crossing two workspaces — or split with multiple body lines.

## Worked example

A ticket touches the API and the web. It fixes a stale import in `apps/web/src/store.ts` along the way. The closing message:

    feat(api,web): expose usage_events from runs view

    - api: aggregate per-run token + cost summary in GET /runs/:id
    - web: render the usage chip in the Run header
    - test: cover empty / single-call / multi-provider runs in api + web
    - doc sync: ROADMAP ENG-012 moved from §3b to §3c as Shipped
    - collateral: apps/web/src/store.ts:42 — stale import to deleted formatBytes helper, replaced with the local Intl formatter

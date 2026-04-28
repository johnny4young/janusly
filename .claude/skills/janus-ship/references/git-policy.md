# Git policy — janus-ship

Both phases (PLAN and EXECUTE) follow the same git rules. The intent: leave the staging in a state where a human can review the suggested commit message, edit it, and run `git commit` themselves.

## Commands the agent NEVER runs

- `git commit`
- `git commit --amend`
- `git push`
- `git tag`
- `git reset` (any variant)
- `git restore --staged`
- `git checkout` on modified files
- `git branch`
- Any `gh pr create` or PR-opening flow

## Commands the agent MAY run

Read-only at any time:

- `git status`
- `git diff`
- `git diff --cached`
- `git diff --stat`
- `git log`
- `git blame`
- `git grep`
- `git show`

## The single mutating command allowed

Only at the very end of PHASE 2, after gates passed and doc-sync is in place:

    git add <paths>          # explicit paths only — never -A or .

The paths must include exactly: ticket files + doc-sync edits + collateral fixes. Confirm with:

    git diff --cached --stat

If the stat shows files outside the approved scope, unstage manually before continuing — do NOT run `git restore --staged`. Instead, redo the `git add` with a corrected path list.

## Rationale

The implementer skill leaves a clean, reviewable staging. The reviewer skill (`janus-review`) then audits that staging without touching the index. The human commits when ready. Splitting work this way keeps the human in the loop on the actual commit boundary.

## Commit message

Print one suggested Conventional Commits message at the end. The human copies, edits, and commits. See [`commit-style.md`](commit-style.md) for the style rules.

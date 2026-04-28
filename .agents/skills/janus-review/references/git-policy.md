# Git policy — janus-review

The reviewer never touches the index. Zero mutating git commands during the entire review.

## Rationale

The reviewer preserves a physical separation:

- **staged** = what the implementer did.
- **unstaged** = what the reviewer fixed inline.

The human commits when ready, and uses `git diff --cached` vs `git diff` to compare both buckets in their IDE. Splitting the work this way keeps the human in the loop on the actual commit boundary and makes review fixes obvious in the final commit.

## Commands the reviewer MAY run (read-only)

- `git status`
- `git diff` — sees the unstaged review fixes.
- `git diff --cached` — sees the staged implementer work.
- `git diff --stat`
- `git diff --cached --stat`
- `git diff HEAD` — both combined.
- `git log` / `git show`
- `git blame` / `git grep`

## Commands the reviewer NEVER runs

- `git add` (any variant: `-p`, `-A`, `-N`, paths)
- `git commit` / `git commit --amend`
- `git reset` (any variant)
- `git restore` (with or without `--staged`)
- `git checkout` on files
- `git stash`
- `git push` / `git pull` / `git fetch`
- `git merge` / `git rebase`
- `git clean`
- `git tag`
- `git branch`

## Inline fixes

Inline fixes are applied with the Edit / Write tools. The modified files land in the working tree (unstaged) automatically — no explicit staging needed and none allowed.

When a fix touches a file that the implementer also modified (a fix on top of staged content), git records the fix as additional unstaged changes on that file. The human can then `git add -p` to selectively pick which hunks to include.

## Closing rule

There is NO closing step that touches git. Finish the report and stop. Staging stays intact with whatever the implementer left; fixes stay unstaged on top.

## Suggested commit message

The report ends with ONE Conventional Commits message that covers the entire universe of changes (staged + unstaged). When the human runs `git add -A && git commit`, the message applies. The reviewer never runs the commit itself.

# Final report template — janus-review

Print the report in chat at the end of the review, in this exact section order. The full template is below; see [`../examples/report-example.md`](../examples/report-example.md) for a worked example.

## Section 1 — Review verdict

    ## Review verdict

    **Reviewed ticket:** ENG-NNN (+ ENG-YYY when applicable)
    **Scope check:** OK / SCOPE CREEP (detail) / OUT OF SYNC WITH APPROVED PLAN
    **Verdict:** READY TO COMMIT / NEEDS DESIGN DISCUSSION / BLOCKED
    **Staging:** Intact (policy: no mutating git)
    **Unstaged:** N files with review fixes

## Section 2 — Gates

    ## Gates

    - pnpm build → PASS / FAIL (detail)
    - pnpm test → PASS / FAIL (detail)
    - pnpm test:e2e → ran / does not apply (reason)
    - typescript-react-reviewer → N findings (real bugs fixed inline; design ones listed below)
    - node → N findings (idem)
    - UI smoke → ran / not run (reason)
    - UI evidence → when the reviewer changed a UI/UX surface, list the PNGs under output/review/<ticketname>/ (e.g. output/review/eng-042/web-en-<surface>.png). Omit the line only when the reviewer made no UI/UX change.
    - Compose down at the end → yes / does not apply

## Section 3 — Bugs fixed inline

    ## Bugs fixed inline (unstaged, show up in `git diff`)

    1. **<title>** — `path/file.ts:L` — what was broken → what fixes it.
    2. **<title>** — `path/file.tsx:L` — ...

    Or: "None — the implementer's diff came in clean."

Single bucket. No severity split. Every real-bug fix the review applied lands here.

## Section 4 — Design / scope findings (NOT fixed)

    ## Design / scope findings — NOT fixed (reported for your input)

    1. **<title>** — `path/file.ts:L`
       - Problem: <description>.
       - Why I did not fix it: design call / changes the approved approach / touches security / AC ambiguity.
       - What I need from you: <specific question>.

    Or: "None."

These are the BLOCKERs when the verdict is `NEEDS DESIGN DISCUSSION`.

## Section 5 — Out-of-scope requirements

    ## Out-of-scope requirements → docs/ROADMAP.md §3b

    - **[domain]** <one line description>. Reason: outside the approved scope of ENG-NNN.

    Or: "None."

When new Pending rows were added to `docs/ROADMAP.md` §3b during the review, list them here. The `docs/ROADMAP.md` file appears in the unstaged bucket like any other inline fix.

## Section 6 — Doc sync checklist

    ## Doc sync checklist (verifying the implementer's work)

    - [x] `docs/ROADMAP.md` §3b Status flipped with summary
    - [ ] `docs/PLAN.md` §X.0 Status Update added (✎ I fixed inline)
    - [x] AGENTS.md (CLAUDE.md symlink intact, no roadmap leaked)
    - [x] README.md without leaked planning (✎ I fixed inline if any)

For any item marked `[ ]` that was completed by the reviewer inline, mark it `[x]` and add `(✎ fixed inline)` so the human sees the reviewer caught the gap.

## Section 7 — Commit message summary

    ## Commit message summary

    feat(<scope>): <one-line description of the ticket>

    - <implementer's main change>
    - <implementer's secondary change>
    - reviewer fix: <file>:<L> — what was broken + fix
    - reviewer fix: <file>:<L> — what was broken + fix
    - roadmap: captured N out-of-scope items in docs/ROADMAP.md
    - collateral: <file>:<L> — what was broken + fix (if the implementer flagged any)

ONE message that covers the entire universe of changes (staged + unstaged). Style rules in the SKILL.md "Hard rules" section: hyphen bullets, no backticks or double quotes in body, no AI co-authorship, scope by workspace.

DO NOT offer a split version of the message. The human decides whether to split via `git add <paths>`.

## Section 8 — How you continue

    ## How you continue

    Staging intact with the implementer's work; unstaged with the reviewer's fixes.

    Useful commands:
    - git diff --cached         → implementer (staged)
    - git diff                  → reviewer fixes (unstaged)
    - git diff HEAD             → unified
    - git diff --stat           → unstaged summary
    - git diff --cached --stat  → staged summary

    Paths to commit:
    - git add -A && git commit -m "<suggested>"   → everything together
    - git add <paths>                              → selective split
    - git restore <path>                           → discard a reviewer fix
    - git restore --staged <path>                  → unstage implementer work

    When the verdict is NEEDS DESIGN DISCUSSION: resolve the BLOCKERs above before committing.

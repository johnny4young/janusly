# Local moderated usability testing

Janusly includes a local-only recorder and report generator for moderated
usability sessions. It measures the five product tasks that define the current
Preview acceptance boundary:

1. create and save a two-step workflow;
2. find a failed run;
3. start recovery for a failed run;
4. open the add-connection flow;
5. open the teammate invitation flow.

The study requires at least five people who are unfamiliar with Janusly.
Automated Playwright coverage proves that the test setup and task affordances
work; it is not a replacement for human evidence.

## Privacy and evidence boundary

- Use a pseudonymous participant alias such as `participant_01`. The CLI
  rejects spaces, email addresses, and arbitrary free text.
- Session and report files are written with owner-only (`0600`) permissions.
- Keep output under the ignored `output/review/` tree. Do not commit participant
  sessions.
- The recorder does not add analytics, cookies, product telemetry, or a new
  application destination.
- Record only the structured observations requested by the CLI. Keep separate
  moderator notes outside the repository if consent and retention policy allow
  them.

## Prepare the disposable local study

Run the automated bilingual readiness smoke before inviting participants:

```bash
export JANUSLY_EVIDENCE_DIR="$PWD/output/review/2026-07-31-usability-study-readiness/final-ui"
pnpm test:e2e -- usability-study-readiness.spec.ts
unset JANUSLY_EVIDENCE_DIR
```

The smoke uses a disposable Postgres/Redis/API/worker/web stack. It proves that
English and Spanish users can reach every study task, checks serious/critical
accessibility violations, detects horizontal overflow and browser errors, and
writes `automated-usability-readiness.json`. Its boundary field deliberately
states that it is not a moderated participant result.

For each real participant, start from a clean organization without sample data.
The moderator may create the one failed run required by the recovery tasks, but
must not explain which global destination to choose.

## Record one participant

Choose one study directory and initialize a session:

```bash
STUDY_DIR="$PWD/output/review/2026-07-31-moderated-usability"

pnpm usability:study -- init \
  --file "$STUDY_DIR/sessions/participant_01.json" \
  --participant participant_01 \
  --locale es
```

Initialization fails if that path already exists, so reusing an alias cannot
silently replace earlier evidence.

After each task, record the observation. The example below records a successful
workflow-creation task completed in 214 seconds:

```bash
pnpm usability:study -- record \
  --file "$STUDY_DIR/sessions/participant_01.json" \
  --task create_workflow \
  --first-click yes \
  --completed yes \
  --duration-seconds 214 \
  --wrong-destinations 0 \
  --used-docs no \
  --used-command-palette no \
  --confidence 4
```

The closed task identifiers are:

```text
create_workflow
find_failed_run
recover_run
add_connection
invite_teammate
```

`duration-seconds` is the time from reading the task to completion or
abandonment. `wrong-destinations` counts global destinations opened before the
participant reaches the correct one. Confidence is a 1–5 post-task rating.

An accidental entry cannot silently overwrite evidence. Correct it explicitly
with the same command plus `--replace yes`; the previous value is retained in
the session's revision history.

After all five tasks have an observation, finalize the session:

```bash
pnpm usability:study -- finish \
  --file "$STUDY_DIR/sessions/participant_01.json"
```

Completed sessions are immutable.

## Generate the acceptance report

After at least five completed sessions:

```bash
pnpm usability:study -- report \
  --sessions "$STUDY_DIR/sessions" \
  --json "$STUDY_DIR/report.json" \
  --markdown "$STUDY_DIR/report.md"
```

The report returns one of three statuses:

- `insufficient_participants` — fewer than five completed participants;
- `failed_thresholds` — five or more participants, but one or more acceptance
  thresholds failed;
- `passed` — all explicit thresholds passed.

The fail-closed thresholds are:

| Metric | Acceptance |
| --- | ---: |
| Completed unfamiliar participants | at least 5 |
| Median time to the first saved two-step workflow | under 300 seconds |
| Wrong global destinations in any task attempt | at most 1 |
| Tasks completed without documentation or command palette | at least 80% |

First-click success, overall completion, and confidence are reported without
inventing thresholds that the product criteria do not currently define.

## Interpreting the result

A passing report means the measured participants met the current local
usability criteria. It does not prove product-market fit, willingness to pay,
external-runtime demand, or production readiness. A failed report should lead
to a focused correction of the affected task journey followed by a new study;
do not merge failed and replacement participants into one favorable result.

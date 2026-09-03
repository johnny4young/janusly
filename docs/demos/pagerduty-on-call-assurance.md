# Demo: PagerDuty on-call assurance

**Recipe:** deterministic PagerDuty authoring compiler

**Audience:** on-call engineers, SRE leads, and workflow operators

**Local walkthrough:** about 5 minutes after Janusly is running

**Story:** "For one bounded on-call period, acknowledge incidents assigned to
me only when they match my time policy, snooze them for 12 hours, and prove
that PagerDuty retained both effects."

This is Janusly's flagship Workflow Assurance journey. It is intentionally not
an AI-generated best guess: a recognized English or Spanish intent maps to one
reviewable graph and exact tenant capabilities. The same journey still works
when `ANTHROPIC_API_KEY` is absent.

## What this demonstrates

1. Natural language becomes an Intent Brief without changing the canvas.
2. Credential and tool identifiers bind only to capabilities that already
   exist in the organization.
3. The operator reviews a proposal before explicitly applying it as a dirty
   draft.
4. Save, validation, activation, and execution remain separate authorized
   operations.
5. Before any write, Janusly re-reads the incident, captures the current action
   time, and evaluates assignment, event type, finite campaign, timezone, daily
   window, and optional filters. If a human approval was requested, Janusly
   repeats the authoritative read and time-policy evaluation after approval;
   stale approvals produce no-action evidence instead of reaching a write.
6. After acknowledge and snooze, Janusly re-reads PagerDuty and verifies the
   exact incident identity, acknowledged status, and snooze deadline returned
   by the write receipt.

The action policy recognizes only `incident.triggered`,
`incident.reassigned`, `incident.escalated`, and `incident.reopened`. Saved
workflow configuration may select a subset, but cannot expand this allowlist.
The provider re-read must also report the incident itself as `triggered`;
already acknowledged or resolved incidents produce bounded no-action evidence
and never reset the snooze.

## Local setup

Start Janusly using the root development commands in the main README. For
managed credentials, also set a local `JANUSLY_CREDENTIAL_MASTER_KEY`; never
commit it.

In **Settings → Connections**, create these two organization-scoped
connections:

| Kind | Example local name | Value for authoring-only review |
| --- | --- | --- |
| `pagerduty_api_token` | `pd-api-local` | Any non-empty local-only value. Do not run the workflow with a dummy value. |
| `pagerduty_webhook_secret` | `pd-webhook-local` | Any non-empty local-only value. Do not register it with PagerDuty. |

If each kind has exactly one configured, unexpired connection, Janusly can bind
the omitted names unambiguously. With zero or multiple candidates it leaves the
binding incomplete. To disambiguate, include the exact names in the intent;
Janusly never invents or silently replaces them.

The workflow also needs:

- the PagerDuty user ID whose assignment authorizes the action;
- the requester's PagerDuty account email;
- a valid IANA timezone;
- a non-empty daily window;
- a snooze duration from 60 seconds through 7 days;
- a finite campaign: either an explicitly anchored relative week or an
  inclusive date range of at most 31 local calendar days.

## Provider-free authoring walkthrough

Open **AI Studio** and use this Spanish example, replacing identities when
needed:

```text
Desde ahora y durante una semana, cuando PagerDuty asigne un incidente al
usuario PUSER1 fuera de 09:00–17:00 en America/Bogota, muévelo a revisando y
aplázalo por 12 horas como operator@example.com.
```

An explicit inclusive range such as `del 2026-09-01 al 2026-09-07` is also
accepted. A relative campaign must say `desde ahora`; a bare
`durante una semana` asks which dates to use rather than guessing.

If the catalog has multiple PagerDuty connections, append:

```text
Usar credencial de API "pd-api-local" y credencial del webhook
"pd-webhook-local".
```

Then move through the four independent stages:

1. **Intent Brief — Compile intent.** Review the objective, trigger, expected
   outcome, failure policy, and at most three clarification questions. Answer
   any missing detail inline and choose **Use answers and compile again**;
   Janusly appends those bounded answers to the visible intent and retains
   earlier answers across further clarification rounds or request failures.
   If the combined text exceeds 4,000 characters, shorten it explicitly:
   Janusly neither sends it nor silently removes any original constraint. An
   incomplete brief cannot proceed.
2. **Capability Binding.** Confirm both exact credential names resolve and
   that there are no binding blockers.
3. **Proposal — Build proposal.** The canonical automatic recipe has 11 nodes,
   11 edges, two external write steps, and intent/recovery/semantic assurance
   contracts. Requesting human approval adds five nodes and six edges: the
   bounded approval, an authoritative re-read, a fresh clock, policy
   revalidation, explicit stale-approval evidence, and its terminal outcome
   projection. Requesting an AI summary adds one post-verification AI node and
   edge.
4. **Apply proposal.** This only places the reviewed proposal on the canvas as
   an unsaved dirty draft. Janusly first refreshes the tenant capability
   catalog; if credentials or other bindings changed, Apply stays blocked until
   the proposal is rebuilt. Save and validate it separately. Do not run an
   authoring-only workflow that uses dummy secrets.

For the canonical deterministic path, the Operational Preview reports zero
external AI calls and the locally measured time to proposal. Those values are
pre-run authoring evidence, not production savings or provider outcomes.

After saving, select the `on_pagerduty` node in the Inspector. Its callback is:

```text
/webhooks/pagerduty/{workflowId}/on_pagerduty
```

The callback path is not authority by itself. Janusly accepts a request only
after verifying the exact raw body with the selected
`pagerduty_webhook_secret`; duplicate event IDs are deduplicated.
That provider event ID also produces a stable tenant-scoped rollout assignment,
and a rollout version must reference the exact credential identity that was
verified before it may receive the event. Here, identity means the
tenant-scoped credential kind and name. Rotation keeps that logical binding but
revokes the old secret immediately, so retries of an accepted event must use
the binding's current live secret; a differently named credential cannot take
over the event.

## Isolated executable qualification

The focused integration journey uses an in-process PagerDuty simulator. It
creates signed events, persists a normal workflow/run, performs both simulated
writes, re-reads provider state, and checks the durable evidence and semantic
detector. It makes zero PagerDuty and zero AI-provider calls.

Run the isolated flagship profile. It freezes the clean commit and tree, creates
a detached source worktree for every Docker, browser, and Go input, then starts
its own guarded Compose project. It captures the English and Spanish browser
journeys, runs the signed webhook/outcome and bounded MCP cases against fresh
PostgreSQL 18, records zero provider calls/cost, and tears both the stack and
source snapshot down:

```bash
make qualify-pagerduty CONFIRM=reset
```

The profile intentionally refuses a dirty worktree: its embedded commit/tree
provenance must describe the exact immutable source being qualified. It also
fails if final diagnostics or the checksummed summary cannot be written. Commit
the local candidate first; this does not push, merge, tag, release, or deploy
it.

For a focused developer rerun against an already fresh PostgreSQL 18 database:

```bash
ANTHROPIC_API_KEY='' \
JANUSLY_DATABASE_URL='postgres://janusly:janusly-local@127.0.0.1:15473/janusly?sslmode=disable' \
go test -tags=integration -count=1 ./internal/httpapi \
  -run '^TestCompiledPagerDutyFlagshipVerifiesProviderOutcome$'
```

The simulator redirect is protected by two local-only gates inside the test.
Production refuses either gate, and a single gate can never redirect traffic.

## Evidence to inspect

For a matching incident, the run should show this ladder:

```text
signed event → authoritative read → action clock → deterministic policy
→ acknowledge → snooze → authoritative re-read
→ exact outcome verification → bounded action evidence
```

The approval variant inserts a 15-minute fail-closed approval gate, then
repeats `authoritative read → action clock → deterministic policy` before the
first write. Automatic rejection or a changed incident/time decision cannot
fall through to acknowledge.

The terminal evidence must contain:

- `actionTaken: true`;
- the exact `evaluatedAt` instant used by the effective pre-write policy;
- `approvalRequired` plus `approvalRevalidated` (both true after a successful
  approval replay; both false for the automatic variant);
- `acknowledgeAccepted: true` and `snoozeAccepted: true`;
- the observed status and snooze deadline;
- `acknowledged: true`, `snoozeVerified: true`, and `verified: true`.

A policy miss follows the no-action branch and records a bounded reason instead
of writing. A post-approval miss records `approvalRevalidated: false` in the
dedicated stale-approval evidence branch. Invalid timestamps, identities,
zones, windows, filters, campaign bounds, chronology, or incident projections
also fail closed.

If a provider accepts the requests but the authoritative re-read does not
match, the run cannot claim success evidence. The
`pagerduty_action_verified` semantic detector opens an observable recovery case
for diagnosis; it does not silently retry non-idempotent writes.

## Useful MCP rehearsal

An MCP client should operate the same assurance cycle rather than becoming a
second workflow engine. A realistic local rehearsal is:

1. Ask **what needs attention** through `operations.brief`; it returns the same
   deterministic top-three priorities shown on Home.
2. Send the PagerDuty intent to `workflows.propose`; inspect its bounded brief,
   exact credential bindings, node/edge counts, and assurance posture. It never
   returns the full DAG or saves a workflow. If the brief still needs exact
   dates, hours, actors, or declared effects, it returns at most three questions
   and no speculative workflow identity.
3. Apply, save, validate, and activate through the authenticated Janusly UI or
   API as the authorized operator.
4. If a semantic recovery case opens, use `recovery.cases.inspect`, then
   `recovery.cases.diagnose` and `recovery.cases.validate` with exact revisions.
5. Create the approval independently in Janusly. Only then may an explicitly
   write-enabled and consented MCP client call `recovery.cases.apply`; MCP has
   no approval tool and cannot approve its own proposal.

This is useful for Codex or another operations assistant because the agent can
triage, propose, diagnose, and validate while Janusly remains the authority for
tenant scope, permissions, immutable candidates, human approval, effects, and
evidence. Do not test this contract with arbitrary shell access disguised as an
MCP tool; use Janusly's bounded server surface.

## Live-provider boundary

This repository currently proves the journey with deterministic unit,
integration, MCP, and browser evidence plus the isolated simulator. It does
not claim a live PagerDuty production result.

A later, separately authorized live pilot should use a PagerDuty sandbox or
test service, real organization-scoped secrets, an HTTPS public callback, and a
prompt that explicitly requires human approval before writes. Start with one
test incident and verify the audit trail before increasing scope.

## Value measurement

Do not turn local timings into a marketing claim. A real pilot should measure:

| Metric | Start | End |
| --- | --- | --- |
| Time to qualified workflow | Intent submission | Proposal ready with zero binding blockers |
| Time to verified action | Signed event accepted | Exact provider outcome verified |
| Manual touches avoided | Baseline acknowledge/snooze steps | Human actions required by the governed flow |
| Safe no-action rate | Policy evaluations | Explicit no-action decisions by reason |
| Unverified-effect rate | Accepted external writes | Semantic recovery cases opened |

Keep the local Operational Preview, provider call count, run evidence, and
pilot outcome metrics separate. Together they show authoring speed, safety, and
operational value without inventing a production baseline.

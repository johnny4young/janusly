# Experience authoring

Janusly has an authoring-owned, local `DecisionProvider` contract for considering
explicit prior-version experiences. The contract is not connected to HTTP
proposal selection, memory retrieval or the editor. Explicit registration is
implemented separately; ordinary
contract-first authoring, routing and recovery are unchanged.

## Policy and authority

A provider proposes one of four closed modes: REUSE, ADAPT, GENERATE or ESCALATE.
The independent policy validator recomputes admission from a caller-owned
projection and rejects stale/invented references. Only a valid receipt contains
the exact workflow and immutable version reference to resolve later. The
projection's eligibility facts must be obtained from scoped readers, not model
output or generic memory metadata. Artifact resolution, current consent,
binding, assurance, readiness and explicit Apply remain separate requirements.

REUSE requires exactly one retained, readable, compatible, same-organization
version and an exact canonical structured brief. The key preserves every field,
ordered list and literal machine identifier without inference or case folding.
ADAPT additionally requires an explicit workflow-name edit only. Configuration,
secrets, approval, effects, topology, trigger timing and child pins cannot be
adapted. A canonical governed recipe retains precedence. Missing exact matches
request GENERATE without granting provider admission; incomplete intent, missing
consent, ambiguity, truncation or unsupported edits require ESCALATE.

Eligibility uses registration, immutable-version availability, retention and
revocation as of a supplied instant. These predicates must also precede top-K
in any persistent reader; this pure contract does not perform a query. A maximum
of five candidate summaries fits in an 8 KiB request. Proposal decoding accepts
one strict JSON object bounded to 4 KiB. Input is copied for the provider and
validated against a separate snapshot. Cancellation fences late responses;
local implementations must honor the 200 ms stage deadline synchronously.

Receipts use closed reasons, rules/fixture provenance and a versioned policy;
they do not expose confidence, verified outcomes or execution permission. Brief
keys are internal matching data, not audit or metric dimensions. There is no
new paid provider, model, embedding process, worker or execution callback.

## Explicit saved-version registry

Registration is an opt-in command, never an automatic consequence of Save,
Apply, a successful run or a model-created memory row. The process gate
`JANUSLY_AUTHORING_EXPERIENCE_ENABLED` is a strict boolean and defaults to false.
Registration and listing also require `JANUSLY_MEMORY_ENABLED=true`, tenant
`ai.authoringExperienceEnabled=true`, `memory.enabled=true`, and exact allowed
kind `workflow_vector`. Malformed or absent required tenant consent is closed.

The same-origin versioned commands are:

- `POST /v1/authoring/experiences/register`: exact `workflowId`, saved `versionId`
  and a complete structured `brief` with all fields/arrays present.
- `GET /v1/authoring/experiences?workflowId=...`: at most five active provenance
  records in registration-time/identity descending order, plus `truncated`.
- `POST /v1/authoring/experiences/revoke`: exact registration `id`; idempotent and
  still available when consent/process gates are closed.

All three require existing `ai.write` and `workflows.read`; mutations additionally
require editor rank and `workflows.write`. Organization and actor come only from
centralized authentication, never the body. Requests reject unknown, duplicate
or differently cased keys, explicit nulls, invalid UTF-8 and lossy normalization.
Briefs are bounded to 8 KiB in both canonical JSON and stored jsonb text;
command objects allow only 512 additional bytes for
reference fields/framing. Secret-shaped material is rejected rather than changed
into a redacted key that could match a different authoritative intent.

The registry stores a validated canonical brief and references, not a duplicate
DAG, credential value, prompt or run snapshot. Composite foreign keys enforce
organization/workflow/version identity. Registration privately parses the exact
saved version, rejects deleted parents and checks the current workflow validator
and capability/intent binder. It never substitutes the latest version. List and
command responses contain provenance only, with `outcomeEvidence: "unknown"`.
Audits record registration identity and closed policy/outcome metadata, not briefs,
content hashes, source graphs or provider errors.

Sorted consent-row locks fence insertion against concurrent revocation. A database
trigger invalidates active registrations atomically when tenant consent is disabled,
deleted or no longer includes `workflow_vector`; rollback also rolls back revocation.
Re-granting never resurrects old registrations. Duplicate explicit requests preserve
the original identity/deadline. Retention follows `workflow_vector` policy (180 days
by default, validated tenant override up to 730); expired registrations may be
explicitly registered anew, never silently renewed. Existing supervised retention
and memory-consent sweeps remove expired/revoked references. Version/workflow hard
deletion cascades; soft-deleted parents are excluded immediately. No new worker,
loop, inference process, embedding call or provider completion is introduced.

This registry does not select proposals or enable automatic reuse. Stored sources
still require re-reading and current consent, binding and review before use.

## Local decisions and exact copies

`RulesProvider` predicts the closed mode from the bounded projection without
receiving expected labels or making network calls. Policy admission remains a
separate snapshot/recomputation. A copied source passes receipt/reference checks,
canonical parsing, current capability/intent binding and workflow validation.
The new unsaved draft has a fresh identity and only an explicitly requested
workflow-name edit; graph identities, configuration, effects, approvals, timing,
outputs and child pins are not repaired or changed. Incompatible sources are
rejected rather than silently upgraded. Source bytes remain unchanged.

The copy primitive consumes a privately supplied exact artifact, not provider
output. It does not itself grant read authority or query the registry: a live
caller must still re-read the source and fence current consent/deletion. HTTP
selection and editor integration are not connected to these local mechanisms.

## Offline mechanical evidence

Run the frozen synthetic corpora with:

```sh
go run ./cmd/authoringcheck internal/authoring/testdata/experience-mechanics.json internal/authoring/testdata/experience-replay.json
go test -race -count=20 ./internal/authoring ./cmd/authoringcheck
go test ./internal/authoring -run '^$' -fuzz '^FuzzDecisionProposalContract$' -fuzztime=5m -parallel=2
go test ./internal/authoring -run '^$' -fuzz '^FuzzDecisionEligibilityProjection$' -fuzztime=5m -parallel=2
```

The original 240 cases are balanced across four modes and English/Spanish,
with entire workflow families held out in the qualification split. Their
manifest and [rubric](../../internal/authoring/testdata/experience-mechanics-rubric.md)
remain frozen. Fixture-proposal contract validation is reported separately from
actual RulesProvider prediction. The same cases also exercise the real legacy
recipe/template selection and binder, and an exact-policy ablation without
experiences. Template binding is not evidence of fulfilling a human objective.

A second [rubric](../../internal/authoring/testdata/experience-replay-rubric.md)
defines 42 frozen EN/ES chronological/source-copy cases. Explicit historical
consent snapshots and registration/version/retention/revocation/deletion facts
are filtered before stable top-K. Later evidence cannot consume the historical
limit or grant past consent. Missing snapshots fail closed. Readability and
compatibility are frozen for each case's catalog/as-of instant, not inferred
from present mutable configuration. Physically purged records cannot reconstruct
history; these replay inputs are independent frozen fixtures.

Reports preserve every outcome and denominator, including invalidated reuse,
cancellations and escalation. Canonical recipe construction is counted separately
from requests for the generative path; neither grants provider admission.
Generation requests avoided by selecting a source
are counted separately from requests deferred to review. Actual logical model
calls and SDK transport requests are both zero: this runner has no provider
client. No real calls avoided, probability, semantic-model accuracy, successful
business effects or time saved are inferred from synthetic decisions.

The runner privately copies fixture graphs through current validation; it never
contacts a network/database, retrieves a live workflow, saves or runs a draft.
Passing does not prove real-world precision, utility, human acceptance or
independently verified effects.

See [AI pipeline](ai-pipeline.md) for the existing authoring authority boundary.

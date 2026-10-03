# Experience authoring contracts

Janusly has an authoring-owned, local `DecisionProvider` contract for considering
explicit prior-version experiences. The contract is not connected to HTTP
proposal selection, memory retrieval, registration or the editor. Ordinary
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

## Offline contract evidence

Run the frozen synthetic corpus with:

```sh
go run ./cmd/authoringcheck internal/authoring/testdata/experience-mechanics.json
go test -race -count=20 ./internal/authoring
go test ./internal/authoring -run '^$' -fuzz '^FuzzDecisionProposalContract$' -fuzztime=5m -parallel=2
go test ./internal/authoring -run '^$' -fuzz '^FuzzDecisionEligibilityProjection$' -fuzztime=5m -parallel=2
```

The 240 cases are balanced across four modes and English/Spanish, with entire
workflow families held out in the qualification split. The manifest freezes
payloads and the [rubric](../../internal/authoring/testdata/experience-mechanics-rubric.md)
defines explicit mechanical labels. The checker validates fixture proposals,
not a rules-provider prediction or semantic model. Tests separately poison
references and permute eligibility. No graph is retrieved, generated, mutated,
saved or run, and no network or database is contacted. Passing does not prove
real-world precision, utility, human acceptance or independently verified effects.

See [AI pipeline](ai-pipeline.md) for the existing authoring authority boundary.

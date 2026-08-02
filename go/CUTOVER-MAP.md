# Route-family cutover map — Node.js to Go

Implementation baseline: 2026-08-02, `origin/go-pilot` at `18b74061`.

The implementation reports cite a 27-case normalized dual-run corpus,
semantic parity fixtures, focused web smokes, race/integration tests, HA and
kill-failover runs, PostgreSQL chaos, a hostile-world benchmark, and a reviewed
24-hour soak. Those are historical implementation inputs. Current certification
status and open gates live in [`AUDIT.md`](AUDIT.md).

## Principle

Traffic moves by coherent route and work-ownership family, not by arbitrary
individual handler. HTTP rollback is a proxy change because both runtimes can
use the same PostgreSQL state, but data compatibility, BullMQ drain, in-flight
work, and scheduler ownership must be rehearsed before that mechanism is called
a proven rollback.

All five route phases have Go implementations. That means no family is planned
to remain permanently on Node; it does **not** mean all five phases are already
certified for production traffic.

## Route phases

| Phase | Families implemented in Go | Implementation evidence to revalidate |
| --- | --- | --- |
| **1 — execution core** | `/workflows/*`, `/start`, `/resume`, `/run*`, `/runs*`, `/v1` run reads, `/dlq*`, signed `/webhooks/*`, `/v1/triggers/*`, `/auth/context`, `/org/config`, `/health*` | dual corpus, semantic parity, run/DLQ effects, failover, data rollback, full web flows |
| **2 — operations and recovery** | `/recovery/*`, `/alerts/*`, `/auto-healing/*`, `/upstream/*`, `/reports/run-explain`, `/system/*`, `/audit`, `/causal`, replay lab, run comparison | integration suites, Activity/Operations browser coverage, hostile-read behavior, recovery-effect parity |
| **3 — administration** | members, roles, permissions, SCIM + WorkOS webhook, credentials, MCP, integrations, evals, experiments, snippets, packs, templates, tools, onboarding, workflow health/metadata/tags/folders, organizations, users, invitations, plugins | authz sweeps, SCIM properties/fixtures, secret and signature tests, administrative browser coverage |
| **4 — AI surfaces** | generation, patch, explain run/workflow, review, suggest improvement, health | provider-neutral fallback, budget/rate gates, scrub, evidence framing, invalid-output rejection |
| **5 — billing and budget ownership** | `/billing/*` and workflow budget routes | contract shapes, complete-window aggregation, organization/workflow budget composition |

Phase boundaries also define non-HTTP ownership. Scheduler, trigger ingestion,
replay campaigns, delayed approvals/timers, and jobs already present in BullMQ
must move with their owning phase; proxy routing cannot transfer queued state.

## Stable and transitional proxy shapes

After every phase is certified, the stable Caddy shape is:

```caddy
janusly.example.com {
  reverse_proxy go-api:4600
}
```

During a gradual transition, Node matchers come first:

```caddy
janusly.example.com {
  # Example only: these families still belong to Node for this tenant.
  @node path /billing/* /ai/explain-run /ai/review-workflow
  reverse_proxy @node node-api:3001
  reverse_proxy go-api:4600
}
```

Tenant selection must be combined with the family matcher. A family rollback
restores its matcher only after the originating runtime's in-flight and queued
work reaches the rehearsed handoff state.

## Deliberate normalized differences

The current dual comparator retains two deliberate classes:

| Difference | Reason | Posture |
| --- | --- | --- |
| `source: env` on four HTTP/subworkflow organization settings | the Node resolver mutates `process.env` and then reports that source | Go retains the truthful `default` source; values and behavior remain compared |
| `errorJson.name` such as `TypeError` versus `Error` | runtime-specific error class vocabulary | normalize class prose; compare error codes, status, and durable outcome exactly |

Three former differences are reported closed in the implementation and must
remain absent when the corpus is re-run: run correlation/trace IDs, node event
granularity, and workflow run-count/version attribution.

## Re-run the implementation evidence

From the repository root:

```bash
node go/conformance/run-reference-stack.mjs node go/conformance/run-dual.mjs
```

From `go/`:

```bash
make verify
```

The dual comparator must fail on every difference outside its explicit
normalization list. Certification adds database-effect comparisons, the full
browser matrix, queue transition, and rollback rehearsal described in
`AUDIT.md`; a 27/27 HTTP result alone is not a cutover decision.

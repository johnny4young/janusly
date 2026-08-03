# Route-family cutover map — Node.js to Go

Implementation baseline: 2026-08-02, `origin/go-pilot` at `18b74061`.

The implementation reports cite a 27-case normalized dual-run corpus,
semantic parity fixtures, focused web smokes, race/integration tests, HA and
kill-failover runs, PostgreSQL chaos, a hostile-world benchmark, and a reviewed
24-hour soak. Those are historical implementation inputs. Current certification
status and open gates live in [`AUDIT.md`](AUDIT.md).

## Principle

Read-only HTTP traffic moves by coherent route family, not by arbitrary
individual handler. The work plane does **not** move by tenant: Go's
PostgreSQL claim and background sweep queries are database-global. Every
mutating entry route, worker, scheduler, timer, campaign, reconciler, and
maintenance loop therefore transfers in one global cut after the BullMQ drain
and rollback rehearsal. HTTP rollback is a proxy change only after that work
plane is quiescent; shared PostgreSQL is not an ownership fence.

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

These phases are certification groupings, not independent live work owners.
Before the global work-plane switch, a production Go candidate must be passive
and only safe reads may shadow or move. At the switch, all mutating route
families and non-HTTP ownership transfer together. Afterward, remaining
read-only families may continue their gradual proxy move. Scheduler, trigger
ingestion, replay campaigns, delayed approvals/timers, and jobs already present
in BullMQ cannot be transferred by proxy routing.

The exact Go candidate must migrate the shared Node database while passive
before the global switch. That bridge installs the Go-only dispatch tables,
reconstructs timer and approval-deadline wakeups, and initializes enabled
schedule due clocks. Run the same idempotent migration again after Node is
quiesced; exact-version boot then fails closed if any bounded waiting
checkpoint lacks its matching durable Go clock.

## Stable and transitional proxy shapes

After every phase is certified, the stable Caddy shape is:

```caddy
janusly.example.com {
  reverse_proxy go-api:4600
}
```

After the global work-plane transition, remaining read-only Node matchers may
still come first:

```caddy
janusly.example.com {
  # Example only: these read projections still come from Node.
  @node path /billing/usage /ai/health
  reverse_proxy @node node-api:3001
  reverse_proxy go-api:4600
}
```

Do not put mutating routes in a gradual matcher. A work-plane rollback restores
Node mutations only after Go's in-flight and queued work reaches the rehearsed
handoff state.

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

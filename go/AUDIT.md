# Go migration certification

This document is the durable evidence ledger for the independent review of the
Go migration. A completed implementation ticket is an input to this review,
not proof that the corresponding production requirement is satisfied.

## Operating rules

- Execute one review band at a time. Each band ends with reproducible evidence,
  a written conclusion, and one focused local commit before the next band.
- Preserve `nodejs-legacy` as the compatibility and rollback oracle.
- Do not rewrite or clean the original `go-pilot` worktree. It contains raw
  performance evidence whose provenance must remain inspectable.
- Prefer executable checks over prose claims. A green unilateral test does not
  establish cross-runtime parity unless its oracle and covered effects are
  identified.
- Keep remote `main` unchanged. Integration may progress through
  `go-pilot -> go-integration -> develop`; the pull request to `main` remains a
  separate final action.

## Frozen baseline

Baseline captured after `git fetch --all --prune` on 2026-08-02.

| Ref | Commit | Relationship to `origin/go-pilot` |
| --- | --- | --- |
| `origin/go-pilot` | `18b7406105697ae3a64f9c9528688c31dde65cc0` | audit source |
| `origin/nodejs-legacy` | `d26e273a9bfbb42b8326142ccb0765f3f6f0442c` | 1 Node-only commit and 249 Go-side commits |
| `origin/develop` | `26ad2f29d96b060df886af63e556b71751b6dab1` | ancestor; 308 Go-side commits |
| `origin/main` | `da51e5df28221610f7c0b6b51b3e96e8323e861c` | 1 merge-only commit and 306 Go-side commits |
| shared Node/Go review pin | `7f0e286b2e885348669273475fa6863abff95f44` | ancestor of the pilot |

`origin/go-integration` did not exist at baseline time. The independent audit
worktree is on `codex/go-pilot-audit`, created from the fetched pilot head.

## Original-worktree evidence inventory

The original `/Users/johnny4young/Personal/github/janusly-go-pilot`
worktree was intentionally left untouched.

| Artifact | State | Classification |
| --- | --- | --- |
| `conformance/perf/k6-last.json` | tracked, modified | reproducible benchmark output from commit `e44af31d`; preserve but do not mix into the audit baseline |
| `conformance/perf/series.jsonl` | tracked, modified | three additional benchmark samples from `e44af31d`; preserve until the performance audit decides whether to retain them |
| `conformance/perf/k6-hostile-last.json` | untracked | transient full k6 summary; the bounded canonical result is already in `hostile-series.jsonl` |
| `conformance/perf/soak-msai3nvx.jsonl` | untracked, 16 samples | interrupted transient soak |
| `conformance/perf/soak-msainaqt.jsonl` | untracked, 259 samples | interrupted transient soak |
| `conformance/perf/soak-msas0wmu.jsonl` | untracked, 1,412 samples | completed 24-hour evidence cited by `SOAK.md`; copied into this audit under a deterministic name |
| `grammar.test` | untracked | Go test binary |
| `seed` | untracked | Go build artifact |

The completed soak series has SHA-256
`854215d3e641fc97c04c79baf6eaa30b457b1ae71222132cac3fe5b9488a3896`.
The interrupted runs and generated binaries are not certification evidence.

## Certification bands

| Band | Required evidence | State |
| --- | --- | --- |
| 1. Baseline and evidence custody | fetched refs, ancestry, clean isolated worktree, raw-evidence inventory | complete |
| 2. Documentation and architecture truth | implementation-to-claim matrix; current AGENTS, reports, cutover map, and runbook | complete |
| 3. Architecture and safety review | file-level findings for engine, API, persistence, concurrency, security, and allocation posture | pending |
| 4. Node/Go contract parity | routes, wire shapes, errors, durable side effects, negative cases, and UI-facing behavior | pending |
| 5. Data and queue transition | fresh/legacy/rollback database matrix plus BullMQ and in-flight-work drain rehearsal | pending |
| 6. Clean validation ladder | CI, race, PG15/18, HA, failover, chaos, fuzz, SDK, benchmark, and soak-evidence audit | pending |
| 7. Full web certification | complete Playwright coverage against Node and Go, EN/ES screenshots, zero unexplained console errors | pending |
| 8. Integration candidate | exact candidate commit revalidated on `go-integration`, promoted to `develop`, with `main` PR left pending | pending |

## Exit criteria

The migration is not certified until all of the following are proven from the
exact candidate commit:

1. No unresolved P0 finding.
2. Contract and durable-effect parity, with every deliberate divergence named.
3. Node-created data remains readable by Go and the rollback runtime can read
   the post-switch state required for recovery.
4. BullMQ, schedulers, delayed work, and in-flight runs have a rehearsed drain
   and rollback procedure; two runtimes never own the global work plane.
5. Full web behavior is exercised against both backends.
6. Security, HA, failover, chaos, fuzz, SDK, and performance gates pass.
7. Documentation distinguishes implemented, locally validated, shadowed, and
   production-enabled states.
8. `nodejs-legacy` remains available as an immutable rollback line.

## Findings ledger

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| DOC-001 | P1 | `AGENTS.md` still said the completed pilot was not mergeable and described the pre-goose schema workflow. | fixed in this band |
| DOC-002 | P1 | `REPORT-W6.md` was a wave-6 snapshot but was presented as the current cutover decision. | fixed in this band |
| DOC-003 | P0 | The cutover map claimed every route phase could move to Go before data, queue, and full-browser certification. | fixed in this band |
| OPS-001 | P1 | `make migrate` still executed the superseded standalone pilot SQL after goose despite claiming single-binary schema ownership. | fixed in this band |
| BLD-001 | P0 | A clean checkout could not compile because the root `dist/` ignore swallowed the claimed tracked webdist placeholder required by `go:embed`. | fixed in this band |
| SEC-001 | P1 | Four signed webhook handlers silently truncated oversized raw bodies, diverging from Node's hard 413 cap and verifying/parsing only a prefix. | fixed in architecture review |
| EVD-001 | P1 | `SOAK.md` cited an untracked random-name series, so the 24-hour verdict was not reproducible from a clean checkout. | fixed in this band |
| TST-001 | P0 | The full Playwright lane was deferred from the pilot and remains a cutover gate. | open |
| TST-002 | P1 | The queue-health integration test started workers that could claim its fixture before the snapshot assertion. | fixed in architecture review |
| QUE-001 | P0 | The current cutover runbook forbids dual schedulers but does not yet prove a BullMQ/in-flight-work drain and rollback procedure. | open |
| QUE-002 | P0 | The cutover map promised per-tenant work ownership even though Go claims and background sweeps are database-global. | fixed in architecture review |
| SRC-001 | P2 | Go source comments contain 134 internal ticket identifiers instead of durable behavioral explanations. | open |
| MOD-001 | P2 | Go 1.26 idioms were not enforced, allowing avoidable allocation and synchronization boilerplate to accumulate. | fixed in this band |
| PAR-001 | P1 | Go org-config writes and environment fallbacks accepted non-finite or negative fractional integer inputs differently from Node and skipped Node's string normalization. | fixed in architecture review |
| SEC-002 | P1 | CI did not run `govulncheck`, and the developer-installed scanner was built with Go 1.25 so it could not parse the Go 1.26 source tree. | fixed in architecture review |
| SEC-003 | P1 | Public and internal HTTP servers bounded only header-read time; full request reads, idle connections, and header bytes retained unbounded/default policy. | fixed in architecture review |
| SEC-005 | P1 | Supabase identity and embedding-provider responses were JSON-decoded without a decoded-body byte cap. | fixed in architecture review |
| SEC-006 | P1 | Credentialed CORS honored `API_ALLOWED_ORIGINS=*` in production, which is unsafe once browser-session reads and mutations are enabled. | fixed in architecture review |
| AUTH-001 | P0 | Go lacked the complete WorkOS browser-session issuance lifecycle required by the web. | fixed in architecture review |
| AUTH-002 | P0 | Go labels bootstrap surfaces identity-scoped but dispatches them through tenant membership resolution, so a legitimate zero-membership identity cannot bootstrap. | fixed in architecture review |
| AUTH-003 | P0 | Go still lacks atomic first-organization creation and atomic invitation acceptance with the exact Node bootstrap response/error contract. | fixed in architecture review |
| DAT-001 | P0 | A pre-Goose Node database was stamped at baseline one even though it lacked Go-owned idempotency/wakeup tables and initialized schedule/timer due clocks. | fixed in architecture review |
| DAT-002 | P1 | `make schema-dump` dumped the shared integration database, committing timestamped fixture tables and a random PostgreSQL 18 restrict key. | fixed in architecture review |
| PAR-002 | P0 | Go could not execute Node approval deadline policies or continue a bounded Node waiting checkpoint. | fixed in architecture review |

## Architecture review decisions

### Browser-session security foundation

The first authentication-parity band deliberately stops before adding routes or
database access. It establishes one shared `v1` HMAC implementation for human
resume, SSO-state, and browser-session tokens while keeping their payloads and
purpose checks separate. Fixed-vector tests prove that existing resume tokens
and the Node generic signed-token envelope retain byte-compatible JSON order,
base64url encoding, and signatures.

The browser cookie carries only the opaque server-side session id and uses
`HttpOnly`, `SameSite=Lax`, `Path=/`, a bounded `Max-Age`, and HTTPS-derived or
explicit `Secure`. Cookie mutations must pass both the custom CSRF marker and
the same concrete-origin policy used by CORS. Development retains wildcard
compatibility, but production ignores `*`; production cookie deployments must
name every allowed origin explicitly.

This band does **not** close `AUTH-001`. The live session row, provider-neutral
identity dispatcher, discovery/logout/organization-switch routes, WorkOS SSO,
and zero-membership bootstrap behavior remain required in later focused bands.
The exact band passed `make ci` on 2026-08-02: generated SQL and OpenAPI were
clean, coverage floors held, build and lint passed, `govulncheck` found no
reachable vulnerabilities, the race-enabled integration suite passed, and
semantic parity F01-F25 remained green.

### Durable session provider and identity boundary

The second authentication-parity band adds the four-mode provider chain in the
same priority as Node: a valid `janusly-session` cookie wins over Supabase,
service-token, and development headers. The opaque cookie id is resolved on
every request through `auth_sessions`; revoked, expired, and missing rows fall
through, while a database failure remains visible instead of silently
downgrading to another provider. The generated store queries cover normalized
creation, active lookup on database time, idempotent revocation, and a
user-bound organization switch that preserves the original expiry.

The resolver now exposes two explicit products: `ResolveIdentity` returns only
provider-verified identity and can succeed with zero memberships, while
`Resolve` still requires `org_members` before returning a tenant `Context` for
human providers. Integration tests prove both halves against PostgreSQL and
also prove that a session organization hint is never authority by itself.

`AUTH-001` and `AUTH-002` remain open: the HTTP dispatcher does not consume the
new identity product yet, and session discovery/logout/organization-switch,
WorkOS SSO, and the full bootstrap projection are not part of this band.
The exact band passed `make ci` on 2026-08-02, including sqlc/OpenAPI drift
checks, coverage floors, build, lint, reachable-vulnerability analysis, the
race-enabled PostgreSQL integration suite, and semantic parity F01-F25.

### Session HTTP lifecycle and identity dispatcher

The third authentication-parity band connects the resolver's two products to
separate fail-closed HTTP dispatchers. Tenant routes still receive only a
membership-authorized `Context`; the closed identity registry receives only
provider `Identity`, and an unregistered identity mount fails with
`route_not_registered`. Cookie-authenticated mutations in either dispatcher
must pass the same custom-marker and concrete-origin CSRF gate before handler
execution.

The Go API now serves the browser contract already used by the web:
`GET /auth/session` is an optional, console-clean signed-out probe;
`POST /auth/session/logout` revokes the server row and clears the cookie; and
`POST /auth/session/organization` proves membership, updates only the matching
live user session, preserves the original expiry, and reissues the signed
cookie. `GET /auth/context` now uses provider identity rather than tenant auth
and returns bounded memberships, roles, sorted permissions, profile,
invitations, selection state, and the labelled development fallback. A live
session with zero memberships receives `needsOrganization: true` instead of a
401, closing `AUTH-002`.

Integration coverage exercises discovery, revocation, organization switching,
membership denial, session rotation, both tenant and identity CSRF paths,
zero-membership bootstrap, and the closed route registries. The exact band
passed `make ci` on 2026-08-02: sqlc/OpenAPI drift, coverage, build, lint,
`govulncheck`, race-enabled integration, and semantic parity F01-F25 are green.
WorkOS session issuance remains open as `AUTH-001`.

### Atomic identity bootstrap

The fourth authentication-parity band closes `AUTH-003`. `POST /organizations`
now accepts only personal Supabase/development identities and commits the
global profile, free-plan organization, admin founder grant, and `org.created`
receipt in one transaction. Optional provider claims never erase an existing
profile, organization/profile names use the Node UTF-16 length contract, and a
successful response is the full bounded bootstrap context with HTTP 201.

Invitation acceptance now locks the matching pending id plus verified email,
then commits the accepted state, normalized profile, conflict-safe membership
grant, and `member.joined` receipt together. Missing, mismatched, already-used,
and concurrent-loser invitations share Node's non-disclosing 404 envelope; the
single winner receives the full bootstrap context. The transaction audit
primitive binds the provider-verified actor while taking the organization only
from state proved inside the transaction, so an organization hint cannot forge
the forensic tenant. Development headers no longer infer a verified email from
an email-shaped user id.

Tests prove rollback on a mid-bootstrap organization conflict, preservation of
an existing optional profile, exact persisted organization/member/profile/audit
rows, and one winner plus seven identical unavailable results under concurrent
invitation acceptance. The exact implementation passed `make ci` on
2026-08-02: sqlc/OpenAPI drift, coverage floors, build, lint, `govulncheck`, the
race-enabled PostgreSQL integration suite, and semantic parity F01-F25 are
green.

### SSO persistence and centralized policy foundation

The fifth authentication-parity band establishes the fail-closed primitives
needed by the WorkOS HTTP lifecycle without mixing provider network behavior
into the same commit. Tenant-scoped sqlc queries now cover bounded WorkOS SSO
connection CRUD, exact-key authentication-policy reads, and atomic live-nonce
consumption. The nonce delete returns the single winning row, so concurrent or
expired callback attempts cannot reuse an authorization response.

SSO state now uses the shared signed-token envelope with the dedicated
`sso_state` purpose, a ten-minute lifetime, and explicit organization, nonce,
and callback bindings. A centralized evaluator runs only after the resolver has
proved the provider identity and tenant grant. It preserves the Node policy
matrix: service tokens bypass human policy, development identities enforce SSO
unless the explicit local bypass is enabled, Supabase identities enforce SSO,
domain, and MFA-marker policy, and durable Janusly sessions enforce domain and
MFA-marker policy without reapplying the SSO-entry requirement. Policy
rejections write a bounded `auth.policy.rejected` receipt, while policy reads
fail to their documented defaults instead of widening configuration scope.

Unit and PostgreSQL integration tests prove tenant isolation, partial updates
and revocation, exactly one concurrent nonce consumer, expiry rejection,
narrow policy loading, provider-specific decisions, audit evidence, and
middleware enforcement. The exact implementation passed `make ci` on
2026-08-02: sqlc/OpenAPI drift, coverage floors, build, lint, `govulncheck`, the
race-enabled PostgreSQL integration suite, and semantic parity F01-F25 are
green. `AUTH-001` remains open until the exact WorkOS callback and atomic
session-issuance contract are served and validated.

### WorkOS administration and authorization start

The sixth authentication-parity band serves the tenant-admin half of the SSO
contract and the public authorization start without prematurely combining the
callback's transactional identity writes. `GET`, `POST`, update, and revoke on
`/org/sso/connections` preserve the Node validation/error envelopes, raw row
projections, admin plus `org.config.write` gate, soft revocation, tenant
invisibility, and the three typed audit actions. Their JSON bodies use the
reference's one-megabyte hard cap and `readJson` plus `asRecord` semantics.

`GET /auth/sso/start` is intentionally public and requires an active
tenant-scoped WorkOS connection. It creates a cryptographically random nonce,
persists the exact expiry from the signed state envelope, binds organization,
callback URL, and connection into the WorkOS redirect, writes
`auth.sso.start` before redirecting, and returns the reference's 302 plus
`Cache-Control: no-store` browser response. Missing organization, callback
configuration, and active connection retain their stable error codes.

The minimal WorkOS client uses the shared SSRF validation and DNS-pinned
transport instead of a vendor SDK, pins `WorkOS-Version: 2024-07-01`, bounds
exchange time to 30 seconds and response bytes to 64 KiB, and never stores the
returned access token. Credential-bearing exchanges explicitly refuse
redirects: stripping authorization headers is not enough when a 307/308 could
replay the form-encoded client secret in the request body.

Validation first exposed an independent probabilistic test bug: five
consecutive canary assignments could trip the recovery circuit breaker before
`TestRolloutAutoRollback` observed its own five-failure sample. Commit
`b52321e2` makes that rollout-specific test opt out of the separate policy; ten
race-enabled repetitions and an isolated `make ci` passed. The WorkOS band
then passed its own full `make ci` on 2026-08-02: sqlc/OpenAPI drift, coverage
floors, build, lint, `govulncheck`, race-enabled PostgreSQL integration, and
semantic parity F01-F25 are green. `AUTH-001` remains open only for the exact
callback verification, policy, atomic membership/audit/session issuance, and
browser completion redirect.

### Atomic WorkOS callback and session issuance

The seventh authentication-parity band closes `AUTH-001`. The public callback
requires both deployment URLs and the WorkOS `code` plus signed `state`, then
checks HMAC purpose/expiry, exact callback binding, atomic live-nonce
consumption, active tenant connection, and the returned WorkOS connection id
in that order. Invalid signatures use the non-attributable `default` audit
tenant; valid but mismatched/replayed state retains the signed organization for
forensics. Exchange, connection, and policy failures write the reference's
bounded `auth.sso.callback_failed` reasons without provisioning a grant.

The WorkOS profile enters the centralized policy evaluator as a
`janusly-session` identity before any mutation. On allow, a single PostgreSQL
transaction upserts the verified-email viewer membership, writes
`auth.sso.login`, and persists the revocable session at the organization policy
TTL. A failure at any later write rolls all three back; only the separate
failure receipt remains. After commit, the browser receives the purpose-bound
opaque session id in an `HttpOnly`, `SameSite=Lax` cookie and a no-store 302 to
`/auth/sso/complete`; no session material enters the redirect URL.

Integration tests prove successful provisioning and 30-minute policy TTL,
one-time replay rejection before a second WorkOS exchange, callback and
connection binding, allowed-domain denial with both policy and SSO receipts,
network failure without membership, and a forced session primary-key conflict
that rolls back the preceding membership plus login audit. The exact band
passed `make ci` on 2026-08-02: sqlc/OpenAPI drift, coverage floors, build,
lint, `govulncheck`, race-enabled PostgreSQL integration, and semantic parity
F01-F25 are green.

### Global work-plane ownership gate

The first queue-transition band closes `QUE-002` and deliberately leaves the
drain rehearsal in `QUE-001` open. The previous per-tenant runbook contradicted
the implementation: Go workers claim eligible PostgreSQL rows globally and
the schedule, campaign, reaper, reconciliation, retention, health, and purge
loops are process-wide. A proxy tenant matcher cannot fence those consumers.

The supported transition now moves one global work plane. A production Go
process defaults passive until `JANUSLY_GO_WORK_PLANE_ENABLED=true` is
explicit. Passive mode does not open the worker pool or start any background
mutation loop, rejects unsafe HTTP methods plus stateful SSO and audited-export
GETs before handler execution, and keeps safe reads available for shadow
comparison. The response header `X-Janusly-Work-Plane` and internal
`janusly_go_work_plane_active` gauge make ownership observable; the in-process
MCP server refuses passive startup because it owns workers by design.

The cutover map and runbook now reserve gradual routing for safe reads. Every
mutating entry route and non-HTTP producer/consumer moves together only after
Node producers stop and the BullMQ/PostgreSQL handoff matrix is clean. The next
queue band must implement and execute that inventory/drain/rollback rehearsal
before `QUE-001` can close.

Unit coverage proves production-default passive, explicit activation, safe
read/preflight passthrough, and pre-handler rejection of unsafe methods and
stateful GETs. A real production-mode process smoke observed passive header,
503, and gauge `0`, then active header, auth dispatch, and gauge `1` after the
explicit flip. The exact band passed `make ci` on 2026-08-02: sqlc/OpenAPI
drift, coverage floors, build, lint, `govulncheck`, race-enabled PostgreSQL
integration, and semantic parity F01-F25 are green.

### Pre-Goose Node database runtime bridge

The first data-transition band closes `DAT-001`. A database with the shared
Node schema no longer becomes operational merely because migration one was
stamped. Migration seven idempotently installs the Go-owned start-idempotency
and wakeup tables, removes the obsolete duplicate runs index, and then a
bounded reconciler reconstructs missing timer wakeups from durable Node
`run_nodes.state_json` checkpoints. Enabled schedules receive their first
`next_fire_at` from the same Go cron parser used at runtime; migration time is
the reference, so upgrade never fabricates an immediate scheduled run.

The migration lifecycle now holds one database advisory lock, pins it to one
physical connection, and stamps versions zero and one in one transaction. It
also recognizes and repairs the partial journal shape produced if an older
binary stopped after creating the journal. Both migration and boot assert the
runtime bridge, and a binary refuses a database that is either behind or ahead
of its exact embedded version.

The bridge now also reconstructs bounded Node approval clocks with the
`approval_timeout` reason. Boot requires the exact clock/reason pair for every
unhandled approval deadline, so the final migration after Node quiescence is a
fail-closed continuation gate rather than a ban on supported workflow policy.

An isolated PostgreSQL integration test creates a temporary database, applies
the captured baseline, removes the Go-only objects and due-clock column, leaves
a partial version-zero journal, and proves upgrade, timer/schedule backfill,
idempotent retry, malformed-timer rejection, readiness repair, and both
timer/approval checkpoint bridges. `make schema-dump` now creates and destroys its own
freshly migrated database and pins PostgreSQL 18's restrict key. Two
consecutive dumps were byte-identical and removed 32 transient
`customer_orders_<timestamp>` fixture tables from `schema.sql` plus their 32
unused generated sqlc model types, closing `DAT-002`.

### Approval deadline parity

`PAR-002` is closed by one shared pure approval-time grammar used by authoring
validation, executor resolution, and checkpoint materialization. Relative
`decisionTimeoutMs` starts from the durable waiting transition; absolute
`until` retains the explicit-timezone contract. The engine persists a
reason-specific PostgreSQL clock and dispatches `fail`, terminal
`auto_reject`, or non-terminal `escalate` without advancing downstream work.

The timeout path holds the per-run completion lock and still applies an exact
deadline-generation node CAS. Manual resume, cancellation, duplicate HA
sweepers, and stale deliveries therefore have one winner. Escalation preserves
the waiting checkpoint, reassigns the operator, records `approval.escalated`,
and clears the consumed clock; terminal policies write the Node-compatible
error and event envelopes plus one `run.failed`. A stale generation re-arms
the currently persisted clock instead of applying it.

The same change fixes a pre-existing wakeup ownership bug: every waiting
transition now clears an inherited execution/retry clock before optionally
installing its own bounded timer or approval clock. Otherwise a retry that
became due immediately before an indefinite approval or human form could have
auto-resumed that human checkpoint. Integration coverage proves all three
policies, relative materialization, manual-resume/HA races, stale-generation
rejection, Node-checkpoint continuation, and inherited-clock cleanup.
The exact staged candidate passed `make ci` on PostgreSQL 18 (generation and
OpenAPI drift, coverage floors, build, zero-issue lint, `govulncheck`, the full
race-enabled integration suite, and semantic parity F01-F25) plus the complete
race-enabled PostgreSQL 15 compatibility lane.

The PostgreSQL 15 validation first exposed an independent queue-health test
race: its ordinary API harness started consumers that could claim the seeded
queued node before the snapshot read. Commit `7e60338d` gives observability
tests a no-worker harness. Twenty race-enabled repetitions passed before the
full PostgreSQL 15 race/integration lane passed on 2026-08-02, closing
`TST-002`.

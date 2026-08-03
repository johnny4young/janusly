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
| 3. Architecture and safety review | file-level findings for engine, API, persistence, concurrency, security, and allocation posture | complete |
| 4. Node/Go contract parity | routes, wire shapes, errors, durable side effects, negative cases, and UI-facing behavior | complete |
| 5. Data and queue transition | fresh/legacy/rollback database matrix plus BullMQ and in-flight-work drain rehearsal | complete |
| 6. Clean validation ladder | CI, race, PG15/18, HA, failover, chaos, fuzz, SDK, benchmark, and soak-evidence audit | complete |
| 7. Full web certification | complete Playwright coverage against Node and Go, EN/ES screenshots, zero unexplained console errors | complete |
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
| TST-001 | P0 | The full Playwright lane was deferred from the pilot and remains a cutover gate. | fixed in full web certification |
| TST-002 | P1 | The queue-health integration test started workers that could claim its fixture before the snapshot assertion. | fixed in architecture review |
| QUE-001 | P0 | The current cutover runbook forbids dual schedulers but does not yet prove a BullMQ/in-flight-work drain and rollback procedure. | fixed in queue transition review |
| QUE-002 | P0 | The cutover map promised per-tenant work ownership even though Go claims and background sweeps are database-global. | fixed in architecture review |
| QUE-003 | P0 | Go-created queued nodes did not maintain Node's publication outbox, so rollback could strand roots/downstream/redrives or lose retry backoff. | fixed in queue transition review |
| SRC-001 | P2 | Go source comments carried more than 130 internal ticket identifiers instead of durable behavioral explanations. | fixed in source-hygiene review |
| EVD-002 | P1 | `make bench` rewrote the complete benchmark report and erased independent allocation and hostile-world evidence. | fixed in clean validation review |
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

### BullMQ drain and rollback handoff

`QUE-001` is closed by an executable cross-store gate, not by a queue-depth
claim. The frozen Node oracle owns four BullMQ queues: `workflow-nodes`,
`maintenance-jobs`, `alerts-system`, and `auto-healing-system`. The policy
catalog covers every current producer/dispatcher and all dynamic workflow,
maintenance, alert, and auto-healing schedulers. A bounded read-only Redis scan
also rejects a fifth queue; unknown jobs/schedulers, deprecated repeatables,
truncated results, and identities that move across the before/after snapshot
all fail closed.

The reviewed handoff drains every active job, `execute-node` delivery, queued
executable row, and materialized `schedule-trigger`. Only exact timer,
approval, replay-campaign, consent-purge, and idempotent system-scan deliveries
may remain parked. Their PostgreSQL checkpoint, clock, or campaign identity is
validated before Go activation. Scheduler retirement uses BullMQ's public
`removeJobScheduler` API and performs no removal if any ownership is unknown;
there is no Redis-key or ad hoc PostgreSQL conversion path.

The review found a separate rollback P0, recorded as `QUE-003`: Go did not
maintain Node's existing queue-publication outbox, so a Go-created queued root,
downstream node, redrive, or retry could be invisible to Node after rollback.
Every Go queued generation now increments `queue_publication_generation` and
sets `queue_publication_repair_after` in the same status transaction. A retry
uses the exact Go wakeup instant; a Go claim clears the marker. Node's unchanged
reconciler therefore republishes ready work, waits for future backoff, and
clears only the Redis-accepted generation. A later Go migration removes a
spent private retry wakeup after Node consumes it.

The isolated rehearsal creates a temporary PostgreSQL database and ephemeral
Redis, then proves: the initial unsafe inventory is red; an unknown fifth
queue/job/scheduler causes zero scheduler removals; reviewed schedulers across
all four queues retire; executable work drains while timer, approval, campaign,
and purge work remains safely parked; a Go retry is not published before its
deadline; Node's real queue-publication reconciler publishes the exact due
generation; Node's real execution CAS accepts it; and the next Go migration
cleans the spent clock before a final green Node-to-Go gate. The machine-readable
result is `conformance/queue-handoff-evidence.json`, keyed by the staged Git
source tree before adding the receipt itself, rather than a mutable branch name.

## Candidate certification evidence

This review reached the runtime candidate at `adf9705b` and then added the
evidence-preservation fix at `91b8aca4`. The latter changes only conformance
scripts, their tests, and performance receipts; it does not change the API or
work-plane binary. The complete `make ci` and PostgreSQL 15 race lanes were run
against the staged tree that became `91b8aca4`.

### Architecture, safety, and contract parity

The focused review commits from `c16724ca` through `adf9705b` close the
security, authentication, migration, queue-ownership, runtime, and wire-shape
findings recorded above. Each implementation band was followed by focused
tests, the complete Go CI ladder, PostgreSQL 15 compatibility when persistence
changed, and browser evidence when the web consumed the surface.

The normalized dual-runtime corpus was regenerated from the frozen Node oracle
and compared with the candidate: all 27 cases were identical after
normalization. The only excluded fields are the four documented organization
configuration source labels in `CUTOVER-MAP.md`; no response, error, database,
event, audit, queue, or rollback divergence was added to the expected list.
The Go semantic integration lane independently passed F01 through F25.

### Full browser corpus

The complete default Playwright corpus ran serially against both backends from
the same checkout:

| Backend | Passed | Intentionally skipped | Failed | Duration |
| --- | ---: | ---: | ---: | ---: |
| frozen Node reference | 114 | 22 | 0 | 7.6 minutes |
| Go candidate | 120 | 16 | 0 | 8.3 minutes |

The count difference is exactly the six Go-pilot smoke cases, all of which ran
and passed against Go and are intentionally skipped against Node. The 16 skips
common to both runs are explicit opt-in qualification profiles for the
persistent Supabase stack, real Anthropic traffic, the persistent Recovery Lab,
semantic-outcome qualification, and forward/rollback orchestration. They were
not silently counted as passes and are separate from the backend-swappable
default corpus.

The executed corpus covers both English and Spanish and completed with no test
failure or unexplained page/console-error assertion. Eighteen inspected local
screenshots remain under `output/review/go-audit/`, covering recovery momentum,
real Solution Pack drills, and technical autonomy in both locales, including
mobile Spanish evidence. The final technical-autonomy pair has SHA-256
`d1247aad6fdc6f18c07d2e0ab12bea351840689e4265b02a6048cc036a615fcd`
(English) and
`bc6fe450dc8661725982c812cc3a6822153f618ec1721b7bf2203ba72bd1c183`
(Spanish), byte-identical to the matching Node captures.

### Clean validation and failure drills

The exact staged candidate passed:

- `make ci`: sqlc and OpenAPI drift checks, the closed queue policy, all 12
  conformance-script tests, coverage floors, build, zero lint findings,
  `govulncheck`, the complete race-enabled unit/integration suite, and F01-F25;
- the complete race-enabled integration suite on PostgreSQL 15;
- the HA-tagged two-pool engine lane under the race detector;
- replica crash failover: 60 runs settled after one active replica was
  `SIGKILL`ed (59 succeeded and one claimed node was loudly reaped), then the
  restarted replica served a 61st terminal run;
- three dedicated-PostgreSQL chaos rounds: the API returned bounded 500
  envelopes while the database was stopped, pools reconnected without a
  process restart, all 33 pre-outage runs became terminal, and exactly-once
  held; two claimed nodes were loudly reaped rather than lost;
- all six 45-second fuzz targets for expressions, templates, cron, external
  runtime events, Markdown PDF, and HTML PDF;
- the live Python SDK lane: 5/5 wire tests against the Go API;
- the isolated Node-to-Go-to-Node-to-Go ownership rehearsal. The refreshed
  receipt attests tree `9b2a87f048a7eb46f7495fa9b94a09299f5d7b56` and every
  phase is green.

### Performance and retained soak evidence

Two consecutive healthy k6 runs against the runtime candidate reported zero
errors and agreed within 2.1% on every metric. The latest run sustained 238
starts/s, 3,539 list reads/s, and 140 completed diamond DAGs/s, with p95 values
of 58 ms, 16 ms, and 104 ms respectively.

Three hostile samples were retained rather than cherry-picked. The final strict
green sample absorbed 1,938 failing starts with zero HTTP errors; hostile/quiet
p95 ratios were 0.70x for run reads, 1.36x for DLQ reads, and 1.99x for public
health. `91b8aca4` prevents either benchmark writer from deleting independent
reviewed evidence and pins the preservation behavior in CI.

The committed soak contains 1,412 samples over 24.0065 hours and has SHA-256
`854215d3e641fc97c04c79baf6eaa30b457b1ae71222132cac3fe5b9488a3896`.
Independent recomputation reproduced the reviewed conclusion: RSS fell 9.40%,
goroutines fell 0.70%, and the apparent 24.38% heap quarter delta is caused by
a documented low-load second eighth. The last six eighths remain flat near
8.8-8.9 MiB, so the retained evidence supports **stable, no leak** without
rewriting the raw automated growth flag.

### Source-comment hygiene

`SRC-001` is closed by replacing internal ticket references with durable
behavioral explanations. The baseline `.go` scan contained 133 `T-###` tokens
across 130 lines; the review also covered SQL query sources, generated SQLC
comments, JavaScript/MJS harnesses, shell scripts, and the Makefile so routine
generation cannot reintroduce the references.

The authoritative SQL query comments were updated before `make generate`, and
the generated store files now match them. A source-only scan under `go/` across
Go, SQL, JavaScript/MJS, shell, and Makefile inputs returns zero `T-###` tokens;
historical identifiers remain only in review and evidence documents where they
provide provenance rather than implementation guidance.

The staged source-hygiene tree passed syntax and formatting checks, all 12
conformance-script tests, the complete `make ci` ladder on PostgreSQL 18, and
the complete race-enabled PostgreSQL 15 compatibility lane.

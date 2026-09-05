# 2026-09 improvement program

Six waves of performance, correctness, architecture and refactoring work,
each landed as local commits on `main` after a green `make verify`. The plan
that drove it lists every finding by id (S/C/P/D/O/B/FB/F/FA/FR/FT/R/A/T).

| Wave | Commits | What changed |
|---|---|---|
| 0 — stop the bleeding | `d1fed9ca`..`c5fdce39` | `JANUSLY_ENV` read one way everywhere; one pinned SSRF redirect policy; sweep errors reach telemetry; subworkflow repair keeps its marker on failure; the SSE hub is supervised and drained; guarded recovery payloads; referentially stable run arrays; placeholder maintenance gauges removed; CI checks every generator. |
| 1 — contract truth | `7f074533`..`ec58df94` | OpenAPI describes `/dlq/clusters` and `/recovery/metrics` as served; 19 reads moved to `contractApi` with a ratchet; error boundary and focus trap fixes; route table frozen; clock injected into events; credentials no longer forwarded across redirects; node/edge caps on save; rate limits on start, SSO and public status; HSTS; tool registry built once. |
| 2 — engine hot path | `69038714`..`93e3845c` | Claim snapshot carried through completion and dispatch; post-commit work only on terminal completions; org config once per claim; narrowed queries; COPY at run start; pinned transports reused; wake-ups by count; scheduler version cache with a wall budget. |
| 3 — database | `62c839ae`..`bdf5c48e` | `schema.sql` generated from a fresh migration; one baseline edit (hot-path indexes, `runs.workflow_id`/`trigger_kind`, audit GIN dropped); dead-letter retention; session limits per pool role; purge cascades; EXPLAIN pins. |
| 4 — frontend, observability, CI | `4ba414b8`..`9ae591af` | Memoized shell; shared guards and models with a ratchet; polling assertions in e2e; HTTP RED metrics and access log; DLQ/AI/pool collectors; HTTP and pgx spans; CI path filters and Playwright cache; UTC-only scheduling documented. |
| Load qualification fixes | `b79cb9ea`, `bd7790bb`, `32156f0c`, `5f84ee56`, `cd17e77b` | Unset `OTEL_EXPORTER` exports nothing; claim as semi-join pinned to its index; idle-first wake fan-out; outcome transactions replayed after lock waits; execution pool lock timeout 30 s; compose PostgreSQL checkpoints tuned. |
| 5 — architecture | `80c0adf4`..`b91c5a34` | Registry and semantic recovery split; 42 fat closures to thin handlers; `internal/httpkit` leaf with `scim` and `externalruntime` feature packages; provider-call seam; `org_id` on run rows; AI Studio, RecoveryDialog, RecoveryCasePanel and RecoveryItemDrawer split into controllers and views; hash router with routed navigation buses; tagged invalidation; first CSS split; budgets raised once by the measured cost. |
| 6 — quality sweep | `e6b94d8d`.. | `unparam` in the lint gate with its fourteen findings fixed; every gated route through `s.route`; the workflow validator dispatches by node type (complexity 256 → 53), the parser decodes nodes and edges in their own functions (118 → 51), and the database tool, recovery contract validator, semantic contract validator, workflow binder, proposal binder, for-each loop, ai node, email tool and AI review sanitizer are each split into named steps (every function under 55, most under 30); 55 unused web exports removed; the duplicated blocks jscpd found folded; `docs/development.md` written. |

## Measured results

Load qualification, 20-minute measured phases, p95 / p99 ms:

| scenario | before (`7420403a`) | after (`cd17e77b`) |
|---|---|---|
| start (10 VUs) | 57 / 169 · 340k iterations | 30 / 48 · 447k |
| list (50 VUs) | 25 / 70 · 3.76M | 16 / 21 · 5.19M |
| diamond (10 VUs) | 123 / 280 · 192k | 128 / 219 · 235k |

Zero errors in every scenario; zero lock timeouts; eleven PostgreSQL
checkpoints in 73 minutes instead of one every ~25 seconds.

## Decisions worth remembering

- R3 (`SELECT *` → explicit columns) was dropped: all 79 are gets and lists
  on configuration tables consumed as model structs.
- Recovery governance stays in the API root package: it depends on effective
  permissions, clusters, metrics, readiness, text search, locale and the
  engine, and two root files call its cores. It is the hub, not a leaf.
- FA7 (UI primitives: 292 raw `<button>`) needs a visual QA pass and was not
  done autonomously. The remaining stylesheet split waits on rule blocks that
  are self-contained (`.we-ops` shares rules with settings and sparklines).
- 43 panels still refetch on the `platformVersion` broadcast; the `platform`
  bridge tag keeps them correct while they migrate to resource tags.

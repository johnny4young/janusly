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
   and rollback procedure; two runtimes never own the same tenant scheduler.
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
| QUE-001 | P0 | The current cutover runbook forbids dual schedulers but does not yet prove a BullMQ/in-flight-work drain and rollback procedure. | open |
| SRC-001 | P2 | Go source comments contain 134 internal ticket identifiers instead of durable behavioral explanations. | open |
| MOD-001 | P2 | Go 1.26 idioms were not enforced, allowing avoidable allocation and synchronization boilerplate to accumulate. | fixed in this band |
| PAR-001 | P1 | Go org-config writes and environment fallbacks accepted non-finite or negative fractional integer inputs differently from Node and skipped Node's string normalization. | fixed in architecture review |
| SEC-002 | P1 | CI did not run `govulncheck`, and the developer-installed scanner was built with Go 1.25 so it could not parse the Go 1.26 source tree. | fixed in architecture review |
| SEC-003 | P1 | Public and internal HTTP servers bounded only header-read time; full request reads, idle connections, and header bytes retained unbounded/default policy. | fixed in architecture review |
| SEC-005 | P1 | Supabase identity and embedding-provider responses were JSON-decoded without a decoded-body byte cap. | fixed in architecture review |
| AUTH-001 | P0 | Go omits the Node `janusly-session` provider and WorkOS browser-session lifecycle, while the web already depends on cookie-session endpoints. | open |

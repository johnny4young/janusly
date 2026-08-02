# Wave 7 implementation closure — certification still active

Implementation close: 2026-08-02. Source baseline: `origin/go-pilot` at
`18b74061`.

Wave 7 completed the 36 planned implementation tickets covering architecture,
resource hygiene, performance, the remaining route families, operability, and
adversarial tests. This report records what the implementation claims; it does
not replace the independent evidence ledger in [`AUDIT.md`](AUDIT.md).

## Delivered implementation

- Real workflow-version attribution and Node-compatible run-count semantics.
- Bounded API, SCIM, completion, and sqlc modules.
- Correlation IDs plus OpenTelemetry tracing and aligned node-event emission.
- LISTEN/NOTIFY-driven dispatch with polling fallback, batched run events, and
  directed allocation reductions in safe persistence.
- Goleak and PostgreSQL connection-baseline gates, supervised process loops,
  and a process-wide cap for external database pools.
- Remaining AI, billing, replay-lab, recovery, identity, causal, object-store,
  PDF, and embedded-web surfaces.
- API-driven demo seed and admin CLI.
- PostgreSQL chaos, package coverage floors, fuzzing, SCIM property sequences,
  and hostile-world read degradation checks.

## Historical evidence reported by the implementation wave

| Area | Reported result |
| --- | --- |
| normalized Node/Go dual corpus | 27/27 |
| semantic parity | green |
| focused web smoke | 15 tabs and 5 flows without unexplained page errors |
| replica kill-failover | three green runs, terminal recovery without silent duplicate execution |
| PostgreSQL chaos | three green rounds with in-process pool recovery |
| hostile reads under failure load | run list 1.22×, DLQ list 1.41×, health 1.34× versus healthy p95 |
| SCIM property sequences | 200 deterministic sequences; two ownership/collision bugs found and fixed |
| 24-hour soak | 1,412 samples; reviewed stable after investigating a baseline artifact |

The completed soak series is now tracked under a deterministic name with a
checksum in `conformance/perf/SOAK.md`.

The first independent clean-checkout command also found that the root `dist/`
ignore prevented the claimed webdist placeholder from ever being committed;
`go:embed` therefore failed before migration or tests could start. The audit
added an explicit root exception and the fallback file. Historical green runs
came from a worktree that already contained generated assets, which reinforces
why the remaining evidence must be re-run from a clean candidate.

## Independent certification status

The candidate is implementation-complete but not yet certified for production
cutover. In particular:

1. The full Playwright suite remains a required cutover gate; focused smokes do
   not prove complete browser behavior.
2. Node-created → Go-upgraded → Node rollback data compatibility is not yet
   proven by a dedicated rehearsal.
3. BullMQ, scheduled/delayed work, and in-flight run ownership need an
   executable drain and rollback matrix.
4. Historical green commands must be re-run from the exact integration
   candidate after audit fixes.

The current decision is therefore **candidate ready for independent review**,
not a production GO. Promotion follows the sequential bands and exit criteria
in `AUDIT.md`.

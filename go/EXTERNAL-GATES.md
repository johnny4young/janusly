# Go external rollout gates

These gates turn facts produced by remote review, CI, qualification, and
runtime operations into candidate-bound release evidence. The recorder only
validates and hashes supplied evidence. It never calls GitHub, deploys a
runtime, changes traffic, or performs a rollback.

## Recording one gate

Generate a fail-closed skeleton for the current commit and tree:

```bash
mkdir -p ../artifacts
make external-gate-template EXTERNAL_GATE=shadow > ../artifacts/shadow-input.json
```

Replace each placeholder with facts exported by the system that owns the gate,
then validate and merge the evidence into the ignored aggregate receipt:

```bash
make external-gate-record \
  EXTERNAL_GATE=shadow \
  EXTERNAL_EVIDENCE=../artifacts/shadow-input.json
```

The recorder requires a clean worktree, an exact candidate match, a supported
schema and policy, and all gate-specific invariants. It stores only a bounded
summary plus the raw file's SHA-256 in `../artifacts/go-external-gates.json`.
Archive raw evidence in the operating system of record. Never edit a receipt
or copy prose into a missing field to make a verdict green.

Remote CI records the immutable Go artifact SHA-256. Every gate that observes
or activates Go repeats the running commit, tree, and artifact SHA-256. The
aggregate policy rejects a runtime gate unless all three match the candidate
and its artifact digest matches remote CI; a healthy process from an older
checkout is not candidate evidence.

## Closed gate sequence

1. **`remote_review`** — an approved, mergeable pull request on `develop` or
   `main`, exact candidate head, and zero unresolved review threads.
2. **`remote_ci`** — a successful exact-head run with a non-empty set of
   successful required checks and the immutable Go artifact SHA-256.
3. **`qualification`** — the exact-candidate qualification receipt with all
   ten no-credit profiles plus `real_provider`, an unchanged source tree, and
   every profile passing.
4. **`shadow`** — at least 100 requests and 60 minutes in a non-local,
   read-only mirror across every route family, comparing HTTP, database rows,
   events, audits, and queues with no unexpected or critical difference and no
   duplicated effect. The exact CI-built Go artifact must report passive by
   both header and metric.
5. **`cutover`** — frozen mutation ingress, stopped Node producers, a passing
   exact-tree Node-to-Go queue handoff, the exact CI-built artifact, active Go
   header and metric, zero ownership overlap, the applied proxy configuration
   hash, and a smoke run.
6. **`canary`** — Go retains global mutation ownership while read routing
   progresses through exactly 1%, 5%, 25%, 50%, and 100%. Every stage needs at
   least 100 samples and 30 minutes, the 100% stage needs a 24-hour soak, and
   all stop thresholds must pass without automatic rollback. The same exact
   CI-built artifact must remain active throughout.
7. **`rollback`** — the frozen Node oracle regains ownership through the
   exact-tree Go-to-Node handoff, backup/restore and Node smoke pass, Activity
   renders, no durable or in-flight work is lost, and measured RTO stays inside
   its declared boundary. Evidence identifies the exact Go artifact being
   rolled back and proves it is passive before Node resumes.

Shadow is observational only. It never permits Node and Go to own any part of
the mutating work plane concurrently. The global ownership transfer follows
[`RUNBOOK-CUTOVER.md`](RUNBOOK-CUTOVER.md), and its queue proof follows
[`QUEUE-HANDOFF.md`](QUEUE-HANDOFF.md).

After all seven exact-candidate receipts have been recorded, evaluate without
performing any external operation:

```bash
make release-production-check
```

Missing, failed, stale, malformed, or unhashed evidence keeps production
readiness red. A new commit or tree invalidates every prior receipt.

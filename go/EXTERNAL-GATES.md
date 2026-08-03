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

Remote CI embeds the complete `manifest.json` downloaded with the immutable Go
artifact, not a digest typed by an operator. Every gate that observes or
activates Go embeds snapshots collected from the running process. The aggregate
policy rejects a runtime gate unless its commit and tree match the candidate
and its executable digest matches remote CI; a healthy process from an older
checkout is not candidate evidence.

## Collecting runtime identity

The collector is read-only and credential-free. It reads `/build` and
`/metrics` from the non-public listener plus `/healthz` from the public origin,
then validates that the executable identity and both work-plane signals agree:

```bash
make runtime-proof \
  RUNTIME_PUBLIC_ORIGIN=https://candidate.example.com \
  RUNTIME_INTERNAL_ORIGIN=http://127.0.0.1:4601 \
  RUNTIME_MODE=passive \
  RUNTIME_PROOF_OUTPUT=../artifacts/shadow-start-runtime.json
```

Run it from the clean exact-candidate checkout. `RUNTIME_MODE` is `passive` for
shadow and rollback or `active` for cutover and canary. The origins may contain
only scheme, host, and optional port; credentials, paths, queries, fragments,
and redirects are rejected. Build/health bodies are capped at 64 KiB and the
metrics scrape at 8 MiB. Keep the internal listener private.

## Closed gate sequence

1. **`remote_review`** — an approved, mergeable pull request on `develop` or
   `main`, exact candidate head, and zero unresolved review threads.
2. **`remote_ci`** — a successful exact-head run with a non-empty set of
   successful required checks and the downloaded release artifact manifest.
   The manifest proves the native target, pinned toolchain posture, exact
   commit/tree, finished executable SHA-256, and unchanged source tree.
3. **`qualification`** — the exact-candidate qualification receipt with all
   ten no-credit profiles plus `real_provider`, an unchanged source tree, and
   every profile passing.
4. **`shadow`** — at least 100 requests and 60 minutes in a non-local,
   read-only mirror across every route family, comparing HTTP, database rows,
   events, audits, and queues with no unexpected or critical difference and no
   duplicated effect. Exactly two machine-collected runtime proofs must show
   the exact CI-built artifact passive at the start and end and span the full
   declared shadow duration.
5. **`cutover`** — frozen mutation ingress, stopped Node producers, a passing
   exact-tree Node-to-Go queue handoff, one active machine-collected proof for
   the exact CI-built artifact, zero ownership overlap, the applied proxy
   configuration hash, and a smoke run.
6. **`canary`** — Go retains global mutation ownership while read routing
   progresses through exactly 1%, 5%, 25%, 50%, and 100%. Every stage needs at
   least 100 samples and 30 minutes, the 100% stage needs a 24-hour soak, and
   all stop thresholds must pass without automatic rollback. An active proof
   is required before the first stage and after every stage soak; timestamps
   must cover each declared soak and the same exact CI-built artifact must
   remain active throughout.
7. **`rollback`** — the frozen Node oracle regains ownership through the
   exact-tree Go-to-Node handoff, backup/restore and Node smoke pass, Activity
   renders, no durable or in-flight work is lost, and measured RTO stays inside
   its declared boundary. Evidence identifies the exact Go artifact being
   rolled back through a machine-collected passive proof before Node resumes.

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

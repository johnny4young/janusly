# Recovery

Recovery is a durable operator-owned lifecycle spanning terminal task failure,
dead-letter evidence, recovery items, replay campaigns, playbooks, drills,
impact attribution, and feedback.

## Invariants

- Terminal failure, dead-letter creation, and run state change are atomic.
- Automatic ownership uses the completion transaction's connection, including
  configuration reads and system audit receipts. Savepoints isolate optional
  failures: unreadable tenant configuration falls back to environment/defaults;
  an incident failure leaves the dead letter intact; an audit failure leaves
  the incident intact. Successful receipts roll back if completion rolls back.
  Savepoint recovery failures abort completion rather than claiming success.
- Replay claims are compare-and-set and bound to the exact failed task.
- Validation replay suppresses external write effects.
- A replay campaign preview lists, per eligible entry, the steps that may change
  external state when the failed step runs again: that step and everything
  downstream of it in the run's snapshot, including branches the run may not
  take. It is the classifier rerun from a step uses, so the two previews cannot
  disagree: write-side tools, tools the registry does not know, non-read HTTP
  methods, MCP tools, subworkflows and write-enabled agents. It reads what a step
  can do, not what it will do. Without a readable snapshot, or past the bound on
  distinct workflows parsed in one preview, `effectsKnown` is false and
  `sideEffect` true, never a silent zero. Entries the rerun lineage will refuse
  stay in the cohort, marked `supersededByRerun`, and settle as failed.
- A replayed campaign item means its redrive committed, before the node runs.
  Nothing tracks whether the run then recovered, so the job's copy says replays
  started and each run's outcome lives in Activity. Item errors reach the client
  as a stable `errorCode`; the raw text stays in the database and the audit trail.
- Rerun from a step (`run-model.md`) is a new linked production run, unlike a
  redrive, which revives the failed node in place. It claims no dead letter and
  credits no recovery impact, and a step it has run again can no longer be
  redriven or replayed.
- Circuit breaking pauses every run entry point and requires explicit resume.
- Buffered event triggers resume oldest-first; missed schedule ticks are not
  synthesized.
- Recovery impact is credited only after generation-bound terminal success.
- AI patches are suggestions. Deterministic evidence, permissions, and
  operator action retain authority. The Suggest fix dialog reads AI availability
  from the bootstrap `GET /ai/health`, with no request of its own. Without a key
  it leads with Replay in Lab when the operator has `runs.start`, stacked over
  the dialog so closing it returns there, and the deterministic fallback envelope stays reachable as Review evidence. An
  unreadable status claims no connection and keeps the suggestion action. Its
  stage rail covers only the steps the dialog has, Patch, Validate and Apply, and
  Validate reads done only after a sandbox pass; errors show no rail.
- A run investigation (`GET /v1/runs/{runId}/investigation`, `runs.read`) is
  deterministic and stores nothing. It evaluates four causes for the run's
  first failed step, in a fixed order, from rows the organization already has.
  Network is validated when the error classifies as `network_timeout`, ruled out
  when it classifies as another known category, and inconclusive when it is
  missing or unclassified; it cites the failed step and other runs in the same
  30-day cluster. Credential is validated by a `secret_missing` category, an
  HTTP 401 or 403 signature, or a named credential that expired before the
  failure; ruled out when the step's config names no credential and holds no
  secret template; otherwise inconclusive. Upstream reads the status sources the
  run's saved version watches: validated when one reports degraded, ruled out
  when the checked ones are healthy, and inconclusive without `upstream.read`,
  watched or checked sources, or for failures older than a day, since the status
  is current. Change compares the run's saved version with the newest earlier
  successful run of the workflow: validated when the versions differ, ruled out
  when they match, and inconclusive without such a run. The conclusion is the
  first validated cause. The single action names the open dead letter and is
  returned only with the same permissions the Recover queue requires for Suggest
  fix; it navigates and never executes. No credential value, prompt or tool
  payload is read into the response.
- Playbooks require exact workflow/signature matching and fresh validation.
- Failure signatures normalize identically in `internal/signature` and
  `web/src/lib/error-signature.ts`. The failure detail derives its summary, cause
  chip and retryable fact from that same classification, stays silent about
  retry when a failure is unclassified, and collapses the raw error JSON.
- Recovery Contract V1 describes technical failure, evidence, effect, repair,
  approval, autonomy, verification, and recurrence boundaries. V1 semantic
  detection is always disabled.
- Recovery Contract V2 adds deterministic semantic detectors and immutable
  pass/violation fixtures. These fixtures are the Qualification Contract; they
  must replay before save and an exact version-pair qualification receipt gates
  rollout when either side is V2.
- Recovery settings retain the source contract's strict nested-object boundary:
  required keys cannot disappear into Go zero values, optional keys reject
  explicit `null`, discriminated detector variants reject cross-kind fields,
  and unknown recovery-policy keys are invalid rather than silently persisted.
  Operator text and node references that the source schema trims are normalized
  before the immutable workflow snapshot is written.
- Governed semantic recovery is source-discriminated and revision-CASed through
  `diagnose -> candidates -> validate -> approve -> apply`. Artifacts are
  content-addressed, sanitized, append-only facts; an apply request names only
  the exact immutable candidate and validation artifacts. Its list, detail,
  Home and MCP reads also fail closed to `source = semantic_violation`; another
  case family cannot inherit semantic autonomy or actions through the shared
  storage table. Aggregate comparable-case evidence used by deterministic and
  AI-enriched diagnosis is source-filtered by the same invariant.
- Observe-only findings move directly from `detected` to `diagnosed`; they never
  claim that downstream work was contained. Only quarantine findings carry a
  `detected -> contained` receipt and may accept a replacement output that
  resumes the same paused generation.
- Approval is a human-authenticated UI/API action, never an MCP capability. Its
  grant is bound to the organization, case, candidate, validation, and exact
  case revision for exactly 30 minutes; it is consumed once or revoked by the
  next lifecycle change. Database constraints enforce the duration and mutually
  exclusive active, consumed, and revoked states. The authenticated HTTP case
  detail may expose only a bounded continuity hint (candidate, validation,
  revision, expiry) so a browser refresh does not force duplicate approval; it
  never exposes the grant id or approving actor. Engine and MCP projections
  remain grant-free, and the apply transaction still owns all authority.
- Replacement output is re-sanitized and re-evaluated against every semantic
  detector in the immutable same-source cohort while node, run, and case rows
  are locked. Publication enters monitoring; only the resumed generation's
  terminal success creates verified-recovery evidence.
- Candidate creation preserves optional-field intent before typed decoding:
  `manualReplacement` cannot be null, its `output` key is required (and may
  itself deliberately contain JSON null), and `acceptLossReason` rejects null.
- `repair_workflow` and `adjust_detector` are deliberately
  `manual_follow_up`, never disguised apply candidates. The recovery UI may
  open only the exact immutable incident version and prefill a bounded
  authoring intent; it does not submit that intent or mutate the case. A
  successor must still be explicitly proposed, applied to the canvas,
  validated, saved, and qualified as a separate workflow version before a new
  recovery decision can refer to it.

Implementation is divided between `internal/recovery`, `internal/engine`, and
recovery handlers in `internal/httpapi`.

## Data-plane recovery boundary

Workflow recovery does not replace database disaster recovery. The local
operator drill uses `scripts/postgres-local-recovery.drill.sh` to exercise
`scripts/postgres-local-recovery.sh` against two disposable PostgreSQL 18
databases and verify a checksum-bound custom-format backup against an empty
isolated target. The helper binds the package to the single embedded migration
source and, when managed credentials exist, to a one-way fingerprint of the
high-entropy credential root key. Restore refuses a running application, a
non-empty database, a different PostgreSQL major, schema drift, checksum
drift, or a mismatched key. The automated positive drill seeds no managed
credentials; key escrow and recovery need a separate operator test.

The application database, Supabase identities, and the credential root key are
three distinct recovery domains. Production operators must back up and test
each domain with its provider controls; the repository helper is a local drill,
not a substitute for managed point-in-time recovery.

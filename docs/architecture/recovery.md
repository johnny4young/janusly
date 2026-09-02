# Recovery

Recovery is a durable operator-owned lifecycle spanning terminal task failure,
dead-letter evidence, recovery items, replay campaigns, playbooks, drills,
impact attribution, and feedback.

## Invariants

- Terminal failure, dead-letter creation, and run state change are atomic.
- Replay claims are compare-and-set and bound to the exact failed task.
- Validation replay suppresses external write effects.
- Circuit breaking pauses every run entry point and requires explicit resume.
- Buffered event triggers resume oldest-first; missed schedule ticks are not
  synthesized.
- Recovery impact is credited only after generation-bound terminal success.
- AI patches are suggestions. Deterministic evidence, permissions, and
  operator action retain authority.
- Playbooks require exact workflow/signature matching and fresh validation.
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
operator drill uses `scripts/postgres-local-recovery.sh` to verify a
checksum-bound PostgreSQL 18 custom-format backup against an empty isolated
target. It binds the package to the single embedded migration source and, when
managed credentials exist, to a one-way fingerprint of the high-entropy
credential root key. Restore refuses a running application, a non-empty
database, a different PostgreSQL major, schema drift, checksum drift, or a
mismatched key.

The application database, Supabase identities, and the credential root key are
three distinct recovery domains. Production operators must back up and test
each domain with its provider controls; the repository helper is a local drill,
not a substitute for managed point-in-time recovery.

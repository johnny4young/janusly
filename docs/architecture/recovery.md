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

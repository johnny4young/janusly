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

Implementation is divided between `internal/recovery`, `internal/engine`, and
recovery handlers in `internal/httpapi`.

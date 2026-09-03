# Run cancellation

Cancellation is a durable compare-and-set transition. A cancelled run rejects
new task claims, prevents downstream publication, and records a terminal event.

An already-running external effect cannot be assumed reversible. Executors
observe cancellation cooperatively and stop before the next effect boundary.
Late completion, resume, timeout, or replay delivery cannot overwrite a
cancelled generation.

The HTTP cancellation route is organization-scoped and idempotently reports the
current terminal state.

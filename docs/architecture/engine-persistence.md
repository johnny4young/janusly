# Engine persistence

Run, task, event, waiting, scheduling, recovery, and deployment state is durable
in PostgreSQL 18. `internal/engine` owns lifecycle ordering; `internal/store`
owns generated SQL access.

Critical transitions use transactions or compare-and-set predicates. A claim
must match its generation before completion can write output. Cancellation,
resume, replay, and timeout delivery cannot overwrite a newer terminal state.

Run events are appended in lifecycle order and published after durable writes.
LISTEN/NOTIFY is only a wake-up path; readers always recover truth from tables.
Persisted payloads are bounded and scrubbed before storage.

A claimed node transfers the run snapshot (`runs.input_json`, the whole
workflow document) exactly once, when the worker loads the claim. The parsed
workflow, start input, replay mode, and version identity ride the claim into
dispatch, completion, downstream scheduling, and semantic evaluation; those
paths re-read only the run's status and identity, on their own transaction
snapshot, through a narrow header query. Hand-built claims (drills, resumes,
parent handoffs) carry no snapshot and fall back to one read. Post-commit
receipts (rollout outcome, run-summary memory) run only for the completion
that rolled the run terminal.

Workflow version appends are engine operations too. HTTP and MCP both submit a
parsed workflow to the same canonical writer, which serializes on the workflow
parent and commits inherited reliability plus schedule reconciliation with the
new immutable version. Transport-specific persistence is forbidden because it
would create different concurrency and activation semantics for the same
business action.

## Process serialization policy

`JANUSLY_PERSIST_MAX_BYTES` is a process-only integer byte limit for default
engine event payloads and audit metadata. Its default is **256000**, with an
accepted range of **2 through the platform's maximum signed integer**
(9223372036854775807 on supported 64-bit runtimes). Empty/whitespace selects the
default; otherwise a trimmed decimal integer is required. Invalid values stop
API and MCP startup without echoing their contents. The previous value `1` is
rejected because even the fail-closed empty JSON object requires two bytes.
Very small valid limits can retain only an empty object or a truncation marker;
use the default unless an operator deliberately accepts reduced diagnostics.

The configured value overrides the built-in default at boot, is copied into an
immutable `grammar.Persister`, and requires a process restart to change. There
is no tenant override. Both composition roots share this policy with the engine
and a pool-independent `audit.Writer`; request handlers, SCIM, external runtime
receipts, authentication rejections, AI budget audits, rate-limit degradation,
upstream polling and MCP invocation audits receive that writer explicitly.
A writer never obtains an extra connection for a caller-owned transaction.

Explicit column rules take precedence over the default: node state remains
1000000 bytes, inline succeeded output retains its 8000-byte threshold, and DLQ
errors remain 64000 bytes. Replay snapshots retain unbounded serialization with
redaction. Fixed-size recovery evidence still rejects truncated artifacts.
Every path preserves sensitive-key and caller-supplied resolved-value redaction.
A policy-free pure helper uses the deterministic built-in default, never the
environment. Tenant configuration continues to be read at its existing scope.

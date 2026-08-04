# AI surfaces

Janusly uses a provider-neutral Go client in `internal/ai`. The supported
completion posture is Anthropic with `claude-haiku-4-5-20251001`; embeddings are
independent and may use self-hosted Ollama.

## Guarantees

- Every provider call is wrapped and returns a deterministic fallback envelope
  on missing credentials, timeout, quota failure, malformed output, or schema
  rejection.
- Provider telemetry is recorded from the central client. A telemetry failure
  never changes the user result.
- Organization budget and output limits are checked before the provider call.
- Prompt context is scrubbed, bounded, and framed as data rather than policy.
- Generated or patched workflows always pass deterministic workflow validation
  before being returned.
- Model output never grants mutation authority. The API, permissions, consent,
  readiness checks, and execution engine remain authoritative.

## HTTP surfaces

- `POST /ai/generate-workflow`
- `POST /ai/explain-workflow`
- `POST /ai/review-workflow`
- `POST /ai/suggest-improvement`
- `POST /ai/patch-workflow`
- `POST /ai/explain-run`

The React AI Studio consumes these routes and clearly labels provider-backed
and fallback results.

## Engine surfaces

The `ai`, `agent`, and `multi_agent` workflow task types resolve tenant-safe AI
configuration before calling `internal/ai`. Sequential multi-agent execution
may use the bounded summaries of completed agents; parallel execution may not.

See [AI pipeline architecture](architecture/ai-pipeline.md) and
[memory policy](memory-policy.md).

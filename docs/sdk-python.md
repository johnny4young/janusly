# Python SDK

The `janusly` Python package is the sibling of the TypeScript SDK at `packages/sdk-node`. It ships typed synchronous and asynchronous clients plus a stdlib-only HMAC verifier for inbound webhooks.

Full reference and examples: `packages/sdk-python/README.md`.

## Installation

```bash
pip install -e packages/sdk-python
```

Requires Python 3.10+. After the release ticket publishes the package to PyPI, consumers can use `pip install janusly`.

## Surfaces

The Python SDK mirrors the TypeScript SDK's four resource bindings. `JanuslyClient` exposes the blocking surface below; `JanuslyAsyncClient` mirrors it 1:1 with `async def` methods (`runs.list` and `runs.stream_events` are async generators). Canonical HTTP shapes documented in [`docs/api.md`](api.md).

| Resource | Method | HTTP route |
| -------- | ------ | ---------- |
| `client.runs` | `start(workflow_id, input=None)` | `GET /workflows/latest` then `POST /start` |
| `client.runs` | `get(run_id, events_limit=None, events_cursor=None)` | `GET /run?runId=…` |
| `client.runs` | `list(workflow_id=None, limit=None)` → `Iterator[dict]` | `GET /runs` |
| `client.runs` | `poll_until_terminal(run_id, interval_ms=1000, timeout_ms=300_000)` | `GET /run` repeatedly |
| `client.runs` | `stream_events(run_id, interval_ms=1000, since_cursor=None)` → `Iterator[dict]` | `GET /run` head-poll |
| `client.runs` | `resume_node(run_id, node_id, input=None, resume_token=None)` | `POST /resume` |
| `client.reports` | `export_run_explain(run_id, format="markdown" | "json")` | `GET /reports/run-explain` |
| `client.recovery` | `get_metrics(window_days=30)` | `GET /recovery/metrics` |
| `client.webhooks` | `verify_signature(body, signature_header, secret, …)` | local (no HTTP) |

## Webhook verification

The verifier is the same Stripe-style HMAC-SHA256 scheme the platform's `webhook.send` tool emits — header `x-janusly-signature: t=<unix-seconds>,v1=<hex>` signing `f"{unix_seconds}.{body}"`. Default clock-skew tolerance ±5 minutes.

**Lightweight import path** (Lambda / Cloudflare Worker Python receivers — no `httpx` pulled in):

```python
from janusly.webhooks import verify_signature
from janusly.errors import JanuslyWebhookSignatureError
```

The verifier raises `JanuslyWebhookSignatureError` with a typed `reason` field (`"malformed_header"` / `"timestamp_skew"` / `"signature_mismatch"`) so the receiver can branch for logging.

**Always pass the RAW request body.** Re-serializing a parsed JSON object produces different bytes and breaks the HMAC. The README has FastAPI + Flask examples that capture the raw body correctly.

## Error hierarchy

```text
JanuslyApiError (base, HTTP errors)
├── JanuslyAuthError          (401, 403)
├── JanuslyValidationError    (400, 422)
├── JanuslyRateLimitError     (429 — carries retry_after_seconds)
└── JanuslyServerError        (5xx)

JanuslyTimeoutError            (client-side polling deadline)
JanuslyWebhookSignatureError   (carries reason field)
```

`JanuslyTimeoutError` and `JanuslyWebhookSignatureError` are NOT subclasses of `JanuslyApiError` — a bare `except JanuslyApiError` won't accidentally swallow signature mismatches or polling timeouts.

## Retries

Both clients accept an opt-in `RetryConfig` (off by default). A transient `429` / `502` / `503` / `504` or a network / timeout error is retried with exponential backoff (`backoff_ms * 2**attempt`); a `429` carrying `Retry-After` uses that delay; 4xx validation errors are never retried. Mirrors the TypeScript SDK's `JanuslyRetryConfig`. See `packages/sdk-python/README.md` for the usage example.

## v1 non-goals (honest)

- **No shared async connection pool / `aclose()` lifecycle.** `JanuslyAsyncClient` mirrors the sync client's stateless per-call transport with a fresh `httpx.AsyncClient` per request.
- **No CLI.** Library only.
- **No PyPI publish yet.** Pip-installable from the repo (`pip install -e packages/sdk-python`). A separate release ticket handles PyPI.

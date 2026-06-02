# Janusly Python SDK

A typed Python client for the Janusly platform, plus a stdlib-only HMAC verifier for inbound webhooks. Sibling of the TypeScript SDK at `packages/sdk-node`.

```bash
pip install -e packages/sdk-python
```

Requires Python 3.10+. The package is not published to PyPI yet; after the release ticket publishes it, consumers can use `pip install janusly`.

## Quickstart

```python
from janusly import JanuslyClient, ServiceTokenAuth

client = JanuslyClient(
    base_url="https://api.janus.ly",
    org_id="acme",
    auth=ServiceTokenAuth(token="...", user_id="ops-bot"),
)

run = client.runs.start(workflow_id="wf-billing", input={"month": "2026-05"})
final = client.runs.poll_until_terminal(run["runId"])
print(final["run"]["status"])  # "succeeded" / "failed" / "cancelled"
```

## Authentication

Two auth modes:

| Mode | Use case | Headers |
| ---- | -------- | ------- |
| `ServiceTokenAuth(token, user_id="sdk-user")` | Server-to-server (the recommended path for backend services + scripts) | `Authorization: Bearer <token>`, `x-org-id: <org_id>`, `x-user-id: <user_id>` |
| `BearerAuth(token)` | User-issued Supabase JWT or equivalent | `Authorization: Bearer <token>`, `x-org-id: <org_id>` |

The base URL is normalized at construction (trailing slashes stripped). The default per-request timeout is 30 seconds.

## Resources

```python
client.runs        # start / get / list / poll / stream / resume
client.reports     # export_run_explain (markdown / json)
client.recovery    # get_metrics
client.webhooks    # verify_signature (stdlib-only)
```

### Use cases

**Start + poll until terminal.**

```python
run = client.runs.start(workflow_id="wf-billing", input={"month": "2026-05"})
final = client.runs.poll_until_terminal(run["runId"], timeout_ms=10 * 60 * 1000)
```

**Stream events as the run progresses.**

```python
for event in client.runs.stream_events(run["runId"]):
    print(event["type"], event.get("nodeId"))
```

`stream_events` yields events in chronological order and dedupes across polls. The iterator stops once the run reaches a terminal status.

**List runs.**

```python
for summary in client.runs.list(workflow_id="wf-billing", limit=50):
    print(summary["id"], summary["status"])
```

The API caps at 100 rows by default (max 200 via `limit`). The iterator is lazy and respects the soft `limit` without buffering.

**Resume a human-form / approval node.**

```python
client.runs.resume_node(
    run_id="run-abc",
    node_id="approval-1",
    input={"approved": True, "comment": "LGTM"},
    resume_token="...",  # signed token from the run's waiting event
)
```

**Export a run-explain report.**

```python
result = client.reports.export_run_explain("run-abc", format="markdown")
with open(result["filename"] or "report.md", "wb") as f:
    f.write(result["body"])
```

`result["filename"]` comes from the server's `Content-Disposition` header (parses both `filename=...` and RFC 5987 `filename*=UTF-8''...` forms).

**Verify an inbound webhook (FastAPI).**

```python
import os
from fastapi import FastAPI, Header, HTTPException, Request

from janusly.webhooks import verify_signature
from janusly.errors import JanuslyWebhookSignatureError

app = FastAPI()

@app.post("/webhooks/janusly")
async def janusly_webhook(
    request: Request,
    x_janusly_signature: str = Header(...),
) -> dict[str, str]:
    # CRITICAL: capture the raw body BEFORE parsing JSON.
    raw_body = await request.body()
    try:
        verify_signature(
            body=raw_body,
            signature_header=x_janusly_signature,
            secret=os.environ["JANUSLY_WEBHOOK_SECRET"],
        )
    except JanuslyWebhookSignatureError as err:
        # reason in {"malformed_header", "timestamp_skew", "signature_mismatch"}
        raise HTTPException(status_code=401, detail=f"webhook rejected: {err.reason}")

    payload = await request.json()  # safe to parse AFTER verification
    # ... handle payload ...
    return {"ok": "true"}
```

**Verify an inbound webhook (plain Python / Flask).**

```python
import os
from flask import Flask, request, abort

from janusly.webhooks import verify_signature
from janusly.errors import JanuslyWebhookSignatureError

app = Flask(__name__)

@app.post("/webhooks/janusly")
def janusly_webhook() -> str:
    # CRITICAL: capture the raw body BEFORE parsing JSON.
    raw_body = request.get_data(as_text=False)
    try:
        verify_signature(
            body=raw_body,
            signature_header=request.headers.get("x-janusly-signature", ""),
            secret=os.environ["JANUSLY_WEBHOOK_SECRET"],
        )
    except JanuslyWebhookSignatureError as err:
        abort(401, description=f"webhook rejected: {err.reason}")
    # ... handle payload via request.get_json() ...
    return "ok"
```

> **Always pass the RAW request body.** Re-serializing a parsed JSON object produces different bytes (key order, whitespace) and breaks the HMAC. FastAPI requires `await request.body()` BEFORE `await request.json()`; Flask requires `request.get_data(as_text=False)`.

The webhook helper imports only Python's standard library (`hmac`, `hashlib`, `time`). A Lambda receiver that only verifies webhooks can `from janusly.webhooks import verify_signature` without pulling in `httpx`.

## Error handling

The SDK raises a typed exception hierarchy. Consumers can `isinstance()` instead of switching on `status_code`.

| HTTP status | Exception class | Notes |
| ----------- | ---------------- | ----- |
| 400, 422 | `JanuslyValidationError` | Request body shape rejected. |
| 401, 403 | `JanuslyAuthError` | Auth header missing / wrong token. |
| 429 | `JanuslyRateLimitError` | Carries `retry_after_seconds` parsed from `Retry-After`. |
| 5xx | `JanuslyServerError` | Server-side failure, generally retryable. |
| other | `JanuslyApiError` | Base class, catch-all. |
| client timeout | `JanuslyTimeoutError` | Raised by `poll_until_terminal`. NOT a subclass of `JanuslyApiError`. |
| webhook | `JanuslyWebhookSignatureError` | Sibling of `JanuslyApiError`. Carries `reason` field. |

```python
import time

from janusly.errors import JanuslyApiError, JanuslyRateLimitError

try:
    client.runs.start(workflow_id="wf-billing")
except JanuslyRateLimitError as err:
    time.sleep(err.retry_after_seconds or 1)
    # retry…
except JanuslyApiError as err:
    print(err.status_code, err.code, err.params)
```

## Notes on retries

The sync client does NOT auto-retry. The TypeScript SDK has opt-in exponential backoff; in Python we leave retry to the caller (one `try/except`, one composable policy — pick whatever library or pattern fits your service).

## Async support

**v1 is sync-only.** Python's sync (`Iterator[X]`) and async (`AsyncIterator[X]`) constructs are not interchangeable, and the most common adoption surfaces (Lambda receivers, glue scripts, batch jobs) prefer sync. FastAPI handlers can call the sync client via `asyncio.to_thread`:

```python
import asyncio

@app.get("/runs/{run_id}")
async def get_run(run_id: str) -> dict:
    return await asyncio.to_thread(client.runs.get, run_id)
```

A `JanuslyAsyncClient` sibling is a future follow-up.

## Development

```bash
cd packages/sdk-python
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
pytest
```

Optional type-check: `mypy --strict src/janusly`.

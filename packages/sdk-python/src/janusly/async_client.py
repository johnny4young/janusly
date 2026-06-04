"""
:class:`JanuslyAsyncClient` — the public asynchronous client surface.

The async sibling of :class:`janusly.client.JanuslyClient`. Every resource
method is a 1:1 mirror of the sync one but ``async def`` + ``await``, so
code already inside an event loop (FastAPI handlers, async batch jobs)
can call the platform natively instead of wrapping the sync client in
``asyncio.to_thread``.

The mirror is deliberately thin: it shares the sync client's transport
config (:func:`janusly._http.make_config`), its pure response helpers
(:data:`TERMINAL_STATUSES`, ``_extract_*``, ``_filename_from_content_disposition``),
and the stdlib-only webhook verifier (:class:`WebhooksResource` — HMAC,
no I/O, so it needs no async variant). Only the transport differs
(:func:`janusly._http.async_request` over :class:`httpx.AsyncClient`),
which means the async client CANNOT drift from the sync one's endpoints,
headers, or error mapping.

Like the sync client, the transport is stateless per call (a fresh
``httpx.AsyncClient`` per request, no shared pool), so there is no
context-manager / ``aclose()`` lifecycle to manage — construct and call.

Example::

    client = JanuslyAsyncClient(
        base_url="https://api.janus.ly",
        org_id="acme",
        auth=ServiceTokenAuth(token="...", user_id="ops-bot"),
    )
    run = await client.runs.start(workflow_id="wf-billing", input={"month": "2026-05"})
    final = await client.runs.poll_until_terminal(run["runId"])
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, AsyncIterator, Literal, Optional
from urllib.parse import quote, urlencode

from ._http import (
    AuthLike,
    BearerAuth,
    ClientConfig,
    RetryConfig,
    ServiceTokenAuth,
    async_request,
    make_config,
)
from .client import (
    TERMINAL_STATUSES,
    WebhooksResource,
    _extract_status,
    _extract_workflow_dag,
    _filename_from_content_disposition,
)
from .errors import JanuslyTimeoutError


class JanuslyAsyncClient:
    """Asynchronous client for the Janusly platform.

    Construction mirrors :class:`janusly.client.JanuslyClient` exactly —
    same constructor args (``base_url`` trailing slashes stripped, default
    30s per-request timeout) and the same four resource bindings
    (``runs`` / ``reports`` / ``recovery`` / ``webhooks``). The only
    difference is that ``runs`` / ``reports`` / ``recovery`` methods are
    awaitable; ``webhooks`` stays synchronous (HMAC verification is pure).
    """

    def __init__(
        self,
        *,
        base_url: str,
        org_id: str,
        auth: AuthLike,
        timeout: float = 30.0,
        user_agent_suffix: str = "",
        retry: Optional[RetryConfig] = None,
    ) -> None:
        self._config: ClientConfig = make_config(
            base_url=base_url,
            org_id=org_id,
            auth=auth,
            timeout=timeout,
            user_agent_suffix=user_agent_suffix,
            retry=retry,
        )
        self._runs = AsyncRunsResource(self._config)
        self._reports = AsyncReportsResource(self._config)
        self._recovery = AsyncRecoveryResource(self._config)
        self._webhooks = WebhooksResource()

    @property
    def runs(self) -> "AsyncRunsResource":
        return self._runs

    @property
    def reports(self) -> "AsyncReportsResource":
        return self._reports

    @property
    def recovery(self) -> "AsyncRecoveryResource":
        return self._recovery

    @property
    def webhooks(self) -> WebhooksResource:
        return self._webhooks


class AsyncRunsResource:
    """``runs`` resource (async) — start / poll / stream / resume runs."""

    def __init__(self, config: ClientConfig) -> None:
        self._config = config

    async def start(
        self,
        *,
        workflow_id: str,
        input: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        """Start a saved workflow by id.

        Two-step flow matching the sync client + TS SDK:
        ``GET /workflows/latest?workflowId=…`` to extract the DAG, then
        ``POST /start`` with the DAG + optional ``input``. Returns
        ``{"runId": str}``.
        """
        latest_response = await async_request(
            self._config,
            method="GET",
            path=f"/workflows/latest?workflowId={quote(workflow_id, safe='')}",
        )
        latest = latest_response.json()
        workflow = _extract_workflow_dag(latest, workflow_id)
        body: dict[str, Any] = {"workflow": workflow}
        if input is not None:
            body["input"] = input
        response = await async_request(
            self._config, method="POST", path="/start", json_body=body
        )
        return response.json()

    async def get(
        self,
        run_id: str,
        *,
        events_limit: Optional[int] = None,
        events_cursor: Optional[str] = None,
    ) -> dict[str, Any]:
        """``GET /run?runId=…`` — fetch a single run with paginated events."""
        params: dict[str, str] = {"runId": run_id}
        if events_limit is not None:
            params["eventsLimit"] = str(events_limit)
        if events_cursor is not None:
            params["eventsCursor"] = events_cursor
        response = await async_request(
            self._config,
            method="GET",
            path=f"/run?{urlencode(params)}",
        )
        return response.json()

    async def list(
        self,
        *,
        workflow_id: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """``GET /runs`` — yield run summaries lazily.

        Async generator: ``async for row in client.runs.list(...)``. Caps
        at 100 rows by default (max 200 via ``limit``); stops when the
        server returns fewer than the cap or the caller's ``limit`` is
        reached. Cursor-compatible once the server emits ``nextCursor``.
        """
        emitted = 0
        target = limit
        cursor: Optional[str] = None
        while True:
            per_page = 200 if target is None else min(200, max(target - emitted, 0))
            if per_page <= 0:
                return
            params: dict[str, str] = {"limit": str(per_page)}
            if workflow_id is not None:
                params["workflowId"] = workflow_id
            if cursor is not None:
                params["cursor"] = cursor
            response = await async_request(
                self._config,
                method="GET",
                path=f"/runs?{urlencode(params)}",
            )
            payload = response.json()
            if isinstance(payload, dict):
                rows = payload.get("runs")
                next_cursor = payload.get("nextCursor")
            else:
                rows = payload
                next_cursor = None
            if not isinstance(rows, list):
                return
            for row in rows:
                if target is not None and emitted >= target:
                    return
                emitted += 1
                yield row
            if not isinstance(next_cursor, str) or not next_cursor:
                return
            cursor = next_cursor

    async def poll_until_terminal(
        self,
        run_id: str,
        *,
        interval_ms: int = 1000,
        timeout_ms: int = 300_000,
    ) -> dict[str, Any]:
        """Poll ``GET /run`` until the run reaches a terminal status.

        Returns the final response. Raises
        :class:`janusly.errors.JanuslyTimeoutError` when the wall-clock
        deadline elapses without a terminal status (default 5 minutes).
        Uses :func:`asyncio.sleep` so the loop yields to the event loop
        between polls.
        """
        deadline = time.monotonic() + timeout_ms / 1000
        interval_s = max(0.05, interval_ms / 1000)
        while True:
            details = await self.get(run_id)
            status = _extract_status(details)
            if status in TERMINAL_STATUSES:
                return details
            if time.monotonic() >= deadline:
                raise JanuslyTimeoutError(
                    f"run {run_id!r} did not reach terminal status within {timeout_ms}ms"
                )
            await asyncio.sleep(interval_s)

    async def stream_events(
        self,
        run_id: str,
        *,
        interval_ms: int = 1000,
        since_cursor: Optional[str] = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Head-poll the run timeline and yield events in chronological order.

        Async generator. Stops once the run reaches a terminal status.
        Dedupes across polls via each event's ``id`` field. ``since_cursor``
        participates ONLY in the first poll (the ``eventsCursor`` on
        ``GET /run`` is the backward-history walker — using it on every
        poll would walk into the past instead of streaming new events at
        the head); after the first call the dedup set filters seen events.
        """
        seen_ids: set[str] = set()
        interval_s = max(0.05, interval_ms / 1000)
        first_iteration = True
        while True:
            if first_iteration and since_cursor is not None:
                details = await self.get(run_id, events_cursor=since_cursor)
            else:
                details = await self.get(run_id)
            first_iteration = False
            events = details.get("events") if isinstance(details, dict) else None
            if isinstance(events, list):
                for event in events:
                    event_id = event.get("id") if isinstance(event, dict) else None
                    if isinstance(event_id, str) and event_id in seen_ids:
                        continue
                    if isinstance(event_id, str):
                        seen_ids.add(event_id)
                    yield event
            if _extract_status(details) in TERMINAL_STATUSES:
                return
            await asyncio.sleep(interval_s)

    async def resume_node(
        self,
        *,
        run_id: str,
        node_id: str,
        input: Optional[dict[str, Any]] = None,
        resume_token: Optional[str] = None,
    ) -> dict[str, Any]:
        """``POST /resume`` — resume a waiting human_form or approval node."""
        body: dict[str, Any] = {"runId": run_id, "nodeId": node_id}
        if input is not None:
            body["input"] = input
        if resume_token is not None:
            body["resumeToken"] = resume_token
        response = await async_request(
            self._config,
            method="POST",
            path="/resume",
            json_body=body,
        )
        return response.json()


class AsyncReportsResource:
    """``reports`` resource (async) — exportable run artefacts."""

    def __init__(self, config: ClientConfig) -> None:
        self._config = config

    async def export_run_explain(
        self,
        run_id: str,
        *,
        format: Literal["markdown", "json"] = "markdown",
    ) -> dict[str, Any]:
        """``GET /reports/run-explain?runId=…`` — download a run report.

        Returns ``{"body": bytes, "content_type": str, "filename":
        str | None}``. ``filename`` is parsed from the
        ``Content-Disposition`` header when present.
        """
        params = {"runId": run_id, "format": format}
        response = await async_request(
            self._config,
            method="GET",
            path=f"/reports/run-explain?{urlencode(params)}",
        )
        return {
            "body": response.content,
            "content_type": response.headers.get("content-type", ""),
            "filename": _filename_from_content_disposition(
                response.headers.get("content-disposition")
            ),
        }


class AsyncRecoveryResource:
    """``recovery`` resource (async) — org-level metrics rollup."""

    def __init__(self, config: ClientConfig) -> None:
        self._config = config

    async def get_metrics(self, *, window_days: int = 30) -> dict[str, Any]:
        """``GET /recovery/metrics?windowDays=N`` — fetch the rollup."""
        params = {"windowDays": str(window_days)}
        response = await async_request(
            self._config,
            method="GET",
            path=f"/recovery/metrics?{urlencode(params)}",
        )
        return response.json()


__all__ = [
    "AsyncRecoveryResource",
    "AsyncReportsResource",
    "AsyncRunsResource",
    "BearerAuth",
    "JanuslyAsyncClient",
    "ServiceTokenAuth",
]

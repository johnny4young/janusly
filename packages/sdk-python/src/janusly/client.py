"""
:class:`JanuslyClient` — the public synchronous client surface.

Mirrors the TypeScript SDK's four resource bindings:

* ``client.runs`` — start a workflow, fetch / list runs, poll until
  terminal, stream events, resume a human-form node.
* ``client.reports`` — export a run-explain report (Markdown / JSON).
* ``client.recovery`` — fetch the org-level recovery metrics rollup.
* ``client.webhooks`` — thin facade over the stdlib-only
  :func:`janusly.webhooks.verify_signature` so callers can write
  ``client.webhooks.verify_signature(...)`` interchangeably with
  ``from janusly.webhooks import verify_signature``.

This is the SYNCHRONOUS client — the most common adoption surfaces
(Lambda receivers, glue scripts, batch jobs) prefer it. Code already
inside an event loop should use the awaitable sibling
:class:`janusly.async_client.JanuslyAsyncClient`, which mirrors this
surface 1:1 over ``httpx.AsyncClient``. Python's sync/async split has no
transparent bridge, so the two clients are separate classes that share
the same transport config, pure helpers, and webhook verifier.
"""

from __future__ import annotations

import time
from typing import Any, Iterator, Literal, Optional, cast
from urllib.parse import quote, urlencode

from ._http import (
    AuthLike,
    BearerAuth,
    ClientConfig,
    RetryConfig,
    ServiceTokenAuth,
    make_config,
    request,
    response_json,
)
from .errors import JanuslyApiError, JanuslyTimeoutError
from .webhooks import verify_signature

TERMINAL_STATUSES = frozenset({"succeeded", "failed", "cancelled", "timed_out"})


class JanuslyClient:
    """Synchronous client for the Janusly platform.

    Example::

        client = JanuslyClient(
            base_url="https://api.janus.ly",
            org_id="acme",
            auth=ServiceTokenAuth(token="...", user_id="ops-bot"),
        )
        run = client.runs.start(workflow_id="wf-billing", input={"month": "2026-05"})
        final = client.runs.poll_until_terminal(run["runId"])

    Trailing slashes on ``base_url`` are stripped at construction. The
    default per-request timeout is 30 seconds (overridable via the
    ``timeout`` constructor arg, or per call where supported).
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
        self._runs = RunsResource(self._config)
        self._reports = ReportsResource(self._config)
        self._recovery = RecoveryResource(self._config)
        self._webhooks = WebhooksResource()

    @property
    def runs(self) -> "RunsResource":
        return self._runs

    @property
    def reports(self) -> "ReportsResource":
        return self._reports

    @property
    def recovery(self) -> "RecoveryResource":
        return self._recovery

    @property
    def webhooks(self) -> "WebhooksResource":
        return self._webhooks


class RunsResource:
    """``runs`` resource — start / poll / stream / resume workflow runs."""

    def __init__(self, config: ClientConfig) -> None:
        self._config = config

    def start(
        self,
        *,
        workflow_id: str,
        input: Optional[dict[str, Any]] = None,
        force_run_during_pause: Optional[bool] = None,
    ) -> dict[str, Any]:
        """Start a saved workflow by id.

        Two-step flow matching the TS SDK: ``GET /v1/workflows/latest?workflowId=…``
        to extract the DAG, then ``POST /v1/start`` with the DAG + optional
        ``input`` payload. Returns ``{"runId": str}``.
        """
        latest_response = request(
            self._config,
            method="GET",
            path=f"/v1/workflows/latest?workflowId={quote(workflow_id, safe='')}",
        )
        latest = response_json(latest_response)
        workflow = _extract_workflow_dag(latest, workflow_id)
        body: dict[str, Any] = {"workflow": workflow}
        if input is not None:
            body["input"] = input
        if force_run_during_pause is not None:
            body["forceRunDuringPause"] = force_run_during_pause
        response = request(self._config, method="POST", path="/v1/start", json_body=body)
        return cast("dict[str, Any]", response_json(response))

    def get(
        self,
        run_id: str,
        *,
        events_limit: Optional[int] = None,
        events_cursor: Optional[str] = None,
    ) -> dict[str, Any]:
        """``GET /v1/run?runId=…`` — fetch a single run with paginated events.

        Use ``events_cursor`` from a prior response to walk older events;
        ``events_has_more`` indicates whether more pages remain.
        """
        params: dict[str, str] = {"runId": run_id}
        if events_limit is not None:
            params["eventsLimit"] = str(events_limit)
        if events_cursor is not None:
            params["eventsCursor"] = events_cursor
        response = request(
            self._config,
            method="GET",
            path=f"/v1/run?{urlencode(params)}",
        )
        return cast("dict[str, Any]", response_json(response))

    def list(
        self,
        *,
        workflow_id: Optional[str] = None,
        status: Optional[str] = None,
        run_kind: Optional[Literal["production", "validation"]] = None,
        limit: Optional[int] = None,
    ) -> Iterator[dict[str, Any]]:
        """``GET /v1/runs`` — yield run summaries lazily.

        The API caps at 100 rows by default (max 200 via ``limit``). The
        iterator stops when the server returns fewer than the cap or
        when the caller's ``limit`` is reached. Future-compatible with
        cursor pagination once the server emits it.
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
            if status is not None:
                params["status"] = status
            if run_kind is not None:
                params["runKind"] = run_kind
            if cursor is not None:
                params["before"] = cursor
            response = request(
                self._config,
                method="GET",
                path=f"/v1/runs?{urlencode(params)}",
            )
            payload = response_json(response)
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

    def poll_until_terminal(
        self,
        run_id: str,
        *,
        interval_ms: int = 1000,
        timeout_ms: int = 300_000,
    ) -> dict[str, Any]:
        """Poll ``GET /v1/run`` until the run reaches a terminal status.

        Returns the final response. Raises :class:`JanuslyTimeoutError`
        when the wall-clock deadline elapses without a terminal status.
        Default deadline is 5 minutes (300_000 ms).
        """
        deadline = time.monotonic() + timeout_ms / 1000
        interval_s = max(0.05, interval_ms / 1000)
        while True:
            details = self.get(run_id)
            status = _extract_status(details)
            if status in TERMINAL_STATUSES:
                return details
            if time.monotonic() >= deadline:
                raise JanuslyTimeoutError(
                    f"run {run_id!r} did not reach terminal status within {timeout_ms}ms"
                )
            time.sleep(interval_s)

    def stream_events(
        self,
        run_id: str,
        *,
        interval_ms: int = 1000,
        since_cursor: Optional[str] = None,
    ) -> Iterator[dict[str, Any]]:
        """Head-poll the run timeline and yield events in chronological order.

        Stops once the run reaches a terminal status. Dedupes across
        polls via the ``id`` field on each event; if a downstream
        consumer needs stricter ordering it can sort by ``createdAt``.

        ``since_cursor`` ONLY participates in the first poll — the
        ``eventsCursor`` on ``GET /v1/run`` is the BACKWARD-history walker
        (loads events older than the cursor) per the platform's
        pagination contract; using it on every poll would make this
        loop walk into the past instead of streaming new events at
        the head. After the first call we drop the cursor and rely on
        the dedup set to filter events we've already yielded.
        """
        seen_ids: set[str] = set()
        interval_s = max(0.05, interval_ms / 1000)
        first_iteration = True
        while True:
            if first_iteration and since_cursor is not None:
                details = self.get(run_id, events_cursor=since_cursor)
            else:
                details = self.get(run_id)
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
            time.sleep(interval_s)

    def resume_node(
        self,
        *,
        run_id: str,
        node_id: str,
        input: Optional[dict[str, Any]] = None,
        resume_token: Optional[str] = None,
    ) -> dict[str, Any]:
        """``POST /v1/resume`` — resume a waiting human_form or approval node."""
        body: dict[str, Any] = {"runId": run_id, "nodeId": node_id}
        if input is not None:
            body["input"] = input
        if resume_token is not None:
            body["resumeToken"] = resume_token
        response = request(
            self._config,
            method="POST",
            path="/v1/resume",
            json_body=body,
        )
        return cast("dict[str, Any]", response_json(response))

    def cancel(self, *, run_id: str, reason: Optional[str] = None) -> dict[str, Any]:
        """``POST /v1/run/cancel`` — cancel an in-flight run.

        Flips the run and its non-running nodes to ``cancelled``; the worker's
        currently-running job drains to completion. An optional ``reason`` is
        recorded on the cancellation audit. A run already in a terminal state
        raises :class:`JanuslyApiError` (``409``).
        """
        body: dict[str, Any] = {"runId": run_id}
        if reason is not None:
            body["reason"] = reason
        response = request(
            self._config,
            method="POST",
            path="/v1/run/cancel",
            json_body=body,
        )
        return cast("dict[str, Any]", response_json(response))


class ReportsResource:
    """``reports`` resource — exportable run artefacts."""

    def __init__(self, config: ClientConfig) -> None:
        self._config = config

    def export_run_explain(
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
        response = request(
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


class RecoveryResource:
    """``recovery`` resource — org-level metrics rollup."""

    def __init__(self, config: ClientConfig) -> None:
        self._config = config

    def get_metrics(self, *, window_days: int = 30) -> dict[str, Any]:
        """``GET /v1/recovery/metrics?windowDays=N`` — fetch the rollup.

        Includes ``timeToFirstAction`` and ``recurrenceRate`` alongside the
        existing recovery, SLA, cluster, cost, and value signals.
        """
        params = {"windowDays": str(window_days)}
        response = request(
            self._config,
            method="GET",
            path=f"/v1/recovery/metrics?{urlencode(params)}",
        )
        return cast("dict[str, Any]", response_json(response))


class WebhooksResource:
    """``webhooks`` resource — facade over the stdlib-only verifier.

    Static-style: no HTTP, no client state. The instance method just
    forwards into :func:`janusly.webhooks.verify_signature` so callers
    can write ``client.webhooks.verify_signature(...)`` interchangeably
    with the direct module import.
    """

    def verify_signature(
        self,
        *,
        body: bytes | str,
        signature_header: str,
        secret: str,
        tolerance_seconds: int = 300,
        now_seconds: int | None = None,
    ) -> dict[str, int]:
        return verify_signature(
            body=body,
            signature_header=signature_header,
            secret=secret,
            tolerance_seconds=tolerance_seconds,
            now_seconds=now_seconds,
        )


# ── Internal helpers ────────────────────────────────────────────────────────


def _extract_workflow_dag(latest: Any, workflow_id: str) -> dict[str, Any]:
    if not isinstance(latest, dict):
        raise JanuslyApiError(
            f"Workflow {workflow_id} returned an unexpected response shape",
            status_code=404,
            code="workflow_not_found",
            params={"workflowId": workflow_id},
        )
    dag = latest.get("dagJson")
    if not isinstance(dag, dict):
        raise JanuslyApiError(
            f"Workflow {workflow_id} has no runnable DAG",
            status_code=422,
            code="workflow_dag_missing",
            params={"workflowId": workflow_id},
        )
    return dag


def _extract_status(details: Any) -> Optional[str]:
    if not isinstance(details, dict):
        return None
    run = details.get("run")
    if isinstance(run, dict):
        status = run.get("status")
        if isinstance(status, str):
            return status
    direct = details.get("status")
    return direct if isinstance(direct, str) else None


def _filename_from_content_disposition(header: Optional[str]) -> Optional[str]:
    """Parse ``filename="..."`` (or ``filename*=UTF-8''...``) from a
    ``Content-Disposition`` header. Best-effort — returns ``None`` when
    neither form parses."""
    if not header:
        return None
    # RFC 5987 form (UTF-8 percent-encoded) preferred.
    star_marker = "filename*="
    star_idx = header.find(star_marker)
    if star_idx >= 0:
        from urllib.parse import unquote

        value = header[star_idx + len(star_marker) :].strip().rstrip(";").strip()
        if value.startswith("UTF-8''"):
            return unquote(value[len("UTF-8''") :])
    plain_marker = "filename="
    plain_idx = header.find(plain_marker)
    if plain_idx >= 0:
        value = header[plain_idx + len(plain_marker) :].strip().rstrip(";").strip()
        if value.startswith('"') and value.endswith('"'):
            return value[1:-1]
        # Trim at the next semicolon if no quotes.
        semi = value.find(";")
        return value if semi < 0 else value[:semi].strip()
    return None


__all__ = [
    "BearerAuth",
    "JanuslyClient",
    "RecoveryResource",
    "ReportsResource",
    "RunsResource",
    "ServiceTokenAuth",
    "WebhooksResource",
]

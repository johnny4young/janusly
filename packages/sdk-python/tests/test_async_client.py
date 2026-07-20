"""Tests for the async client — a 1:1 mirror of the sync suite.

``pytest-httpx``'s ``httpx_mock`` fixture intercepts ``httpx.AsyncClient``
just like ``httpx.Client``, so each test is the sync test with ``await``
added. ``asyncio_mode = "auto"`` (pyproject) runs ``async def test_*``
without a per-test marker.
"""

from __future__ import annotations

import json

import pytest
from pytest_httpx import HTTPXMock

from janusly import BearerAuth, JanuslyAsyncClient, ServiceTokenAuth
from janusly._http import async_request, make_config
from janusly.errors import JanuslyApiError, JanuslyRateLimitError, JanuslyTimeoutError
from helpers import v1


@pytest.fixture
def client() -> JanuslyAsyncClient:
    return JanuslyAsyncClient(
        base_url="https://api.test.janus.ly",
        org_id="test-org",
        auth=ServiceTokenAuth(token="test-token", user_id="test-user"),
    )


async def test_start_workflow_does_two_step_flow(
    client: JanuslyAsyncClient, httpx_mock: HTTPXMock
) -> None:
    """start() loads /workflows/latest then POSTs /start with the DAG."""
    httpx_mock.add_response(
        url="https://api.test.janus.ly/v1/workflows/latest?workflowId=wf-billing",
        json=v1({"dagJson": {"nodes": [], "edges": []}}),
    )
    httpx_mock.add_response(
        url="https://api.test.janus.ly/v1/start",
        json=v1({"runId": "run-123"}),
        method="POST",
    )
    result = await client.runs.start(
        workflow_id="wf-billing",
        input={"month": "2026-05"},
        force_run_during_pause=True,
    )
    assert result == {"runId": "run-123"}

    posted = httpx_mock.get_requests()[1]
    body = json.loads(posted.content.decode("utf-8"))
    assert body["workflow"] == {"nodes": [], "edges": []}
    assert body["input"] == {"month": "2026-05"}
    assert body["forceRunDuringPause"] is True


async def test_start_workflow_rejects_missing_dag_as_validation_error(
    client: JanuslyAsyncClient, httpx_mock: HTTPXMock
) -> None:
    """A latest-version response without dagJson maps to the 422 shape."""
    httpx_mock.add_response(
        url="https://api.test.janus.ly/v1/workflows/latest?workflowId=wf-bad",
        json=v1({}),
    )
    with pytest.raises(JanuslyApiError) as err:
        await client.runs.start(workflow_id="wf-bad")
    assert err.value.status_code == 422
    assert err.value.code == "workflow_dag_missing"


async def test_get_run_round_trip(
    client: JanuslyAsyncClient, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(
        url="https://api.test.janus.ly/v1/run?runId=run-123",
        json=v1({"run": {"id": "run-123", "status": "running"}, "events": []}),
    )
    result = await client.runs.get("run-123")
    assert result["run"]["status"] == "running"


async def test_list_yields_capped_rows(
    client: JanuslyAsyncClient, httpx_mock: HTTPXMock
) -> None:
    """list() is an async generator over the runs list."""
    httpx_mock.add_response(
        url="https://api.test.janus.ly/v1/runs?limit=200",
        json=v1({"runs": [{"id": f"r{i}"} for i in range(5)]}),
    )
    rows = [row async for row in client.runs.list()]
    assert len(rows) == 5
    assert rows[0]["id"] == "r0"


async def test_list_follows_future_cursor_pages(
    client: JanuslyAsyncClient, httpx_mock: HTTPXMock
) -> None:
    """The async iterator mirrors the future-compatible nextCursor loop."""
    httpx_mock.add_response(
        url="https://api.test.janus.ly/v1/runs?limit=3&status=failed&runKind=validation",
        json=v1({"runs": [{"id": "r1"}, {"id": "r2"}], "nextCursor": "cursor-2"}),
    )
    httpx_mock.add_response(
        url="https://api.test.janus.ly/v1/runs?limit=1&status=failed&runKind=validation&before=cursor-2",
        json=v1({"runs": [{"id": "r3"}], "nextCursor": None}),
    )
    rows = [
        row
        async for row in client.runs.list(
            limit=3, status="failed", run_kind="validation"
        )
    ]
    assert [row["id"] for row in rows] == ["r1", "r2", "r3"]


async def test_poll_until_terminal_returns_on_terminal(
    client: JanuslyAsyncClient, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(
        url="https://api.test.janus.ly/v1/run?runId=run-789",
        json=v1({"run": {"id": "run-789", "status": "succeeded"}, "events": []}),
    )
    result = await client.runs.poll_until_terminal(
        "run-789", interval_ms=50, timeout_ms=1000
    )
    assert result["run"]["status"] == "succeeded"


async def test_poll_until_terminal_raises_on_deadline(
    client: JanuslyAsyncClient, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(
        url="https://api.test.janus.ly/v1/run?runId=run-456",
        json=v1({"run": {"id": "run-456", "status": "running"}, "events": []}),
        is_reusable=True,
    )
    with pytest.raises(JanuslyTimeoutError):
        await client.runs.poll_until_terminal(
            "run-456", interval_ms=50, timeout_ms=150
        )


async def test_stream_events_dedupes_and_stops_on_terminal(
    client: JanuslyAsyncClient, httpx_mock: HTTPXMock
) -> None:
    """stream_events yields each event once and stops at terminal status."""
    httpx_mock.add_response(
        url="https://api.test.janus.ly/v1/run?runId=run-s",
        json=v1({
            "run": {"id": "run-s", "status": "succeeded"},
            "events": [
                {"id": "e1", "type": "run.started"},
                {"id": "e2", "type": "node.succeeded"},
            ],
        }),
    )
    events = [event async for event in client.runs.stream_events("run-s", interval_ms=50)]
    assert [event["id"] for event in events] == ["e1", "e2"]


async def test_stream_events_uses_since_cursor_only_on_first_poll(
    client: JanuslyAsyncClient, httpx_mock: HTTPXMock
) -> None:
    """since_cursor rides ONLY the first poll; later polls drop it so the
    loop streams forward instead of walking backward into history."""
    # First poll: cursor present, run still running → loop continues.
    httpx_mock.add_response(
        url="https://api.test.janus.ly/v1/run?runId=run-c&eventsCursor=cur-0",
        json=v1({"run": {"id": "run-c", "status": "running"}, "events": [{"id": "e1"}]}),
    )
    # Second poll: NO cursor, terminal → loop stops.
    httpx_mock.add_response(
        url="https://api.test.janus.ly/v1/run?runId=run-c",
        json=v1({"run": {"id": "run-c", "status": "succeeded"}, "events": [{"id": "e2"}]}),
    )
    events = [
        event
        async for event in client.runs.stream_events(
            "run-c", interval_ms=50, since_cursor="cur-0"
        )
    ]
    assert [event["id"] for event in events] == ["e1", "e2"]
    requests = httpx_mock.get_requests()
    assert "eventsCursor=cur-0" in str(requests[0].url)
    assert "eventsCursor" not in str(requests[1].url)


async def test_bearer_auth_on_async_client_omits_user_id(httpx_mock: HTTPXMock) -> None:
    """BearerAuth sends Authorization but no x-user-id on the async path."""
    bearer_client = JanuslyAsyncClient(
        base_url="https://api.test.janus.ly",
        org_id="acme",
        auth=BearerAuth(token="jwt-token"),
    )
    httpx_mock.add_response(
        url="https://api.test.janus.ly/v1/recovery/metrics?windowDays=30",
        json=v1({}),
    )
    await bearer_client.recovery.get_metrics()
    sent = httpx_mock.get_requests()[0]
    assert sent.headers["Authorization"] == "Bearer jwt-token"
    assert "x-user-id" not in {key.lower() for key in sent.headers}


async def test_resume_node_posts_payload(
    client: JanuslyAsyncClient, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(
        url="https://api.test.janus.ly/v1/resume",
        json=v1({"resumed": True}),
        method="POST",
    )
    result = await client.runs.resume_node(
        run_id="run-X",
        node_id="approval-1",
        input={"approved": True},
        resume_token="t-1",
    )
    assert result == {"resumed": True}

    body = json.loads(httpx_mock.get_requests()[0].content.decode("utf-8"))
    assert body == {
        "runId": "run-X",
        "nodeId": "approval-1",
        "input": {"approved": True},
        "resumeToken": "t-1",
    }


async def test_cancel_posts_payload(
    client: JanuslyAsyncClient, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(
        url="https://api.test.janus.ly/v1/run/cancel",
        json=v1({"runId": "run-X", "status": "cancelled"}),
        method="POST",
    )
    result = await client.runs.cancel(
        run_id="run-X",
        reason="superseded by a newer run",
    )
    assert result == {"runId": "run-X", "status": "cancelled"}

    body = json.loads(httpx_mock.get_requests()[0].content.decode("utf-8"))
    assert body == {
        "runId": "run-X",
        "reason": "superseded by a newer run",
    }


async def test_cancel_omits_reason_when_not_supplied(
    client: JanuslyAsyncClient, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(
        url="https://api.test.janus.ly/v1/run/cancel",
        json=v1({"runId": "run-X", "status": "cancelled"}),
        method="POST",
    )
    await client.runs.cancel(run_id="run-X")

    body = json.loads(httpx_mock.get_requests()[0].content.decode("utf-8"))
    assert body == {"runId": "run-X"}


async def test_cancel_raises_on_terminal_run(
    client: JanuslyAsyncClient, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(
        url="https://api.test.janus.ly/v1/run/cancel",
        status_code=409,
        json={
            "apiVersion": "v1",
            "requestId": "sdk-test",
            "error": {"message": "Run is already terminal", "code": "runs_already_terminal"},
        },
        method="POST",
    )
    with pytest.raises(JanuslyApiError) as err:
        await client.runs.cancel(run_id="run-X")
    assert err.value.status_code == 409
    assert err.value.code == "runs_already_terminal"


async def test_export_run_explain_parses_filename(
    client: JanuslyAsyncClient, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(
        url="https://api.test.janus.ly/reports/run-explain?runId=r-1&format=markdown",
        content=b"# Report",
        headers={
            "content-type": "text/markdown; charset=utf-8",
            "content-disposition": 'attachment; filename="janusly-billing-failed-2026-05-21.md"',
        },
    )
    result = await client.reports.export_run_explain("r-1", format="markdown")
    assert result["body"] == b"# Report"
    assert result["content_type"].startswith("text/markdown")
    assert result["filename"] == "janusly-billing-failed-2026-05-21.md"


async def test_get_metrics_threads_window_days(
    client: JanuslyAsyncClient, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(
        url="https://api.test.janus.ly/v1/recovery/metrics?windowDays=7",
        json=v1({"successRate": {"value": 0.95}, "windowDays": 7, "terminalRuns": 10}),
    )
    result = await client.recovery.get_metrics(window_days=7)
    assert result["windowDays"] == 7
    assert result["successRate"]["value"] == 0.95


async def test_error_mapping_on_async_path(
    client: JanuslyAsyncClient, httpx_mock: HTTPXMock
) -> None:
    """A non-2xx on the async transport maps to the same typed hierarchy as sync."""
    httpx_mock.add_response(
        url="https://api.test.janus.ly/v1/recovery/metrics?windowDays=30",
        status_code=429,
        json={
            "apiVersion": "v1",
            "requestId": "sdk-test",
            "error": {"message": "Too many requests", "code": "mcp_rate_limited"},
        },
        headers={"retry-after": "5"},
    )
    with pytest.raises(JanuslyRateLimitError) as err:
        await client.recovery.get_metrics()
    assert err.value.status_code == 429
    assert err.value.retry_after_seconds == 5.0


async def test_header_injection_guard_holds_on_async_transport(
    httpx_mock: HTTPXMock,
) -> None:
    """The shared reserved-header guard rejects collisions on async_request too."""
    config = make_config(
        base_url="https://api.test.janus.ly",
        org_id="acme",
        auth=ServiceTokenAuth(token="t", user_id="u"),
    )
    with pytest.raises(ValueError, match="reserved header"):
        await async_request(
            config,
            method="GET",
            path="/run?runId=x",
            extra_headers={"x-org-id": "other-org"},
        )
    # The guard fires before any request is issued.
    assert httpx_mock.get_requests() == []

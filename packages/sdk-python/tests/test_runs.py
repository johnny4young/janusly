"""Tests for the runs resource (start, get, list, poll_until_terminal, resume, cancel)."""

from __future__ import annotations

import pytest
from pytest_httpx import HTTPXMock

from janusly import JanuslyClient, ServiceTokenAuth
from janusly.errors import JanuslyApiError, JanuslyTimeoutError


@pytest.fixture
def client() -> JanuslyClient:
    return JanuslyClient(
        base_url="https://api.test.janus.ly",
        org_id="test-org",
        auth=ServiceTokenAuth(token="test-token", user_id="test-user"),
    )


def test_start_workflow_does_two_step_flow(client: JanuslyClient, httpx_mock: HTTPXMock) -> None:
    """start() loads /workflows/latest then POSTs /start with the DAG."""
    httpx_mock.add_response(
        url="https://api.test.janus.ly/workflows/latest?workflowId=wf-billing",
        json={"dagJson": {"nodes": [], "edges": []}},
    )
    httpx_mock.add_response(
        url="https://api.test.janus.ly/start",
        json={"runId": "run-123"},
        method="POST",
    )
    result = client.runs.start(workflow_id="wf-billing", input={"month": "2026-05"})
    assert result == {"runId": "run-123"}

    # Validate that the second request carried the DAG + input.
    posted = httpx_mock.get_requests()[1]
    import json

    body = json.loads(posted.content.decode("utf-8"))
    assert body["workflow"] == {"nodes": [], "edges": []}
    assert body["input"] == {"month": "2026-05"}


def test_start_workflow_rejects_missing_dag_as_validation_error(
    client: JanuslyClient,
    httpx_mock: HTTPXMock,
) -> None:
    """A latest-version response without dagJson maps to the TS SDK's 422 shape."""
    httpx_mock.add_response(
        url="https://api.test.janus.ly/workflows/latest?workflowId=wf-bad",
        json={},
    )
    with pytest.raises(JanuslyApiError) as err:
        client.runs.start(workflow_id="wf-bad")
    assert err.value.status_code == 422
    assert err.value.code == "workflow_dag_missing"


def test_get_run_round_trip(client: JanuslyClient, httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url="https://api.test.janus.ly/run?runId=run-123",
        json={"run": {"id": "run-123", "status": "running"}, "events": []},
    )
    result = client.runs.get("run-123")
    assert result["run"]["status"] == "running"


def test_list_yields_capped_rows(client: JanuslyClient, httpx_mock: HTTPXMock) -> None:
    """list() returns an iterator over the runs list."""
    httpx_mock.add_response(
        url="https://api.test.janus.ly/runs?limit=200",
        json={"runs": [{"id": f"r{i}"} for i in range(5)]},
    )
    rows = list(client.runs.list())
    assert len(rows) == 5
    assert rows[0]["id"] == "r0"


def test_list_follows_future_cursor_pages(
    client: JanuslyClient,
    httpx_mock: HTTPXMock,
) -> None:
    """The iterator mirrors the TS SDK's future-compatible nextCursor loop."""
    httpx_mock.add_response(
        url="https://api.test.janus.ly/runs?limit=3",
        json={"runs": [{"id": "r1"}, {"id": "r2"}], "nextCursor": "cursor-2"},
    )
    httpx_mock.add_response(
        url="https://api.test.janus.ly/runs?limit=1&cursor=cursor-2",
        json={"runs": [{"id": "r3"}], "nextCursor": None},
    )
    rows = list(client.runs.list(limit=3))
    assert [row["id"] for row in rows] == ["r1", "r2", "r3"]


def test_poll_until_terminal_raises_on_deadline(
    client: JanuslyClient,
    httpx_mock: HTTPXMock,
) -> None:
    """poll_until_terminal raises JanuslyTimeoutError when the deadline elapses
    without a terminal status."""
    httpx_mock.add_response(
        url="https://api.test.janus.ly/run?runId=run-456",
        json={"run": {"id": "run-456", "status": "running"}, "events": []},
        is_reusable=True,
    )
    with pytest.raises(JanuslyTimeoutError):
        client.runs.poll_until_terminal("run-456", interval_ms=50, timeout_ms=150)


def test_poll_until_terminal_returns_on_terminal(
    client: JanuslyClient,
    httpx_mock: HTTPXMock,
) -> None:
    """poll_until_terminal returns the run details once status flips to terminal."""
    httpx_mock.add_response(
        url="https://api.test.janus.ly/run?runId=run-789",
        json={"run": {"id": "run-789", "status": "succeeded"}, "events": []},
    )
    result = client.runs.poll_until_terminal("run-789", interval_ms=50, timeout_ms=1000)
    assert result["run"]["status"] == "succeeded"


def test_resume_node_posts_payload(client: JanuslyClient, httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url="https://api.test.janus.ly/resume",
        json={"resumed": True},
        method="POST",
    )
    result = client.runs.resume_node(
        run_id="run-X",
        node_id="approval-1",
        input={"approved": True},
        resume_token="t-1",
    )
    assert result == {"resumed": True}

    import json

    body = json.loads(httpx_mock.get_requests()[0].content.decode("utf-8"))
    assert body == {
        "runId": "run-X",
        "nodeId": "approval-1",
        "input": {"approved": True},
        "resumeToken": "t-1",
    }


def test_cancel_posts_payload(client: JanuslyClient, httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url="https://api.test.janus.ly/run/cancel",
        json={"runId": "run-X", "status": "cancelled"},
        method="POST",
    )
    result = client.runs.cancel(run_id="run-X", reason="stuck on a bad input")
    assert result == {"runId": "run-X", "status": "cancelled"}

    import json

    body = json.loads(httpx_mock.get_requests()[0].content.decode("utf-8"))
    assert body == {"runId": "run-X", "reason": "stuck on a bad input"}


def test_cancel_omits_reason_when_not_supplied(
    client: JanuslyClient,
    httpx_mock: HTTPXMock,
) -> None:
    httpx_mock.add_response(
        url="https://api.test.janus.ly/run/cancel",
        json={"runId": "run-X", "status": "cancelled"},
        method="POST",
    )
    client.runs.cancel(run_id="run-X")

    import json

    body = json.loads(httpx_mock.get_requests()[0].content.decode("utf-8"))
    assert body == {"runId": "run-X"}


def test_cancel_raises_on_terminal_run(
    client: JanuslyClient,
    httpx_mock: HTTPXMock,
) -> None:
    """Cancelling an already-terminal run maps the route's 409 to a typed error."""
    httpx_mock.add_response(
        url="https://api.test.janus.ly/run/cancel",
        json={"error": "Run is already succeeded; cannot cancel"},
        status_code=409,
        method="POST",
    )
    with pytest.raises(JanuslyApiError) as err:
        client.runs.cancel(run_id="run-done")
    assert err.value.status_code == 409

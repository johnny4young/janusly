"""Live wire lane against the Go pilot (T-187).

Skipped unless ``JANUSLY_SDK_LIVE_URL`` is set — the ordinary unit suite
stays hermetic. Driven by ``go/conformance/run-sdk-live.mjs``, which boots
the Go binary with a service token, seeds the org member + a saved
workflow, and exports:

  JANUSLY_SDK_LIVE_URL    the Go API base url
  JANUSLY_SDK_LIVE_TOKEN  the service token
  JANUSLY_SDK_LIVE_ORG    the seeded org id
  JANUSLY_SDK_LIVE_WF     the seeded workflow id

The point is the SAME WIRE: the SDK's envelope unwrap, two-step start,
polling, error mapping, and metrics read must hold against Go exactly as
they do against Node.
"""

from __future__ import annotations

import itertools
import os

import pytest

from janusly import JanuslyClient, ServiceTokenAuth
from janusly.errors import JanuslyApiError

LIVE_URL = os.environ.get("JANUSLY_SDK_LIVE_URL")

pytestmark = pytest.mark.skipif(
    not LIVE_URL, reason="JANUSLY_SDK_LIVE_URL not set; run via go/conformance/run-sdk-live.mjs"
)


@pytest.fixture()
def client() -> JanuslyClient:
    return JanuslyClient(
        base_url=LIVE_URL or "",
        org_id=os.environ["JANUSLY_SDK_LIVE_ORG"],
        auth=ServiceTokenAuth(
            token=os.environ["JANUSLY_SDK_LIVE_TOKEN"], user_id="sdk-live"
        ),
    )


def test_start_poll_and_get_roundtrip(client: JanuslyClient) -> None:
    workflow_id = os.environ["JANUSLY_SDK_LIVE_WF"]
    started = client.runs.start(workflow_id=workflow_id, input={"note": "sdk-live"})
    assert isinstance(started.get("runId"), str) and started["runId"]

    final = client.runs.poll_until_terminal(started["runId"], interval_ms=100, timeout_ms=30_000)
    run = final["run"] if isinstance(final.get("run"), dict) else final
    assert run["status"] == "succeeded"

    details = client.runs.get(started["runId"], events_limit=10)
    nodes = details.get("nodes")
    assert isinstance(nodes, list) and len(nodes) >= 1
    assert all(node["status"] == "succeeded" for node in nodes)


def test_list_runs_pages(client: JanuslyClient) -> None:
    # ``list`` is a paginating iterator (the TS SDK's asyncIterator shape).
    rows = list(itertools.islice(client.runs.list(limit=5), 5))
    assert len(rows) >= 1
    assert {"id", "status"} <= set(rows[0].keys())


def test_unknown_run_maps_the_uniform_403(client: JanuslyClient) -> None:
    with pytest.raises(JanuslyApiError) as failure:
        client.runs.get("ghost-run-id")
    assert failure.value.status_code == 403
    assert failure.value.code == "runs_forbidden"


def test_recovery_metrics_shape(client: JanuslyClient) -> None:
    metrics = client.recovery.get_metrics(window_days=30)
    assert isinstance(metrics, dict) and metrics


def test_cancel_terminal_run_is_a_clean_conflict(client: JanuslyClient) -> None:
    workflow_id = os.environ["JANUSLY_SDK_LIVE_WF"]
    started = client.runs.start(workflow_id=workflow_id)
    client.runs.poll_until_terminal(started["runId"], interval_ms=100, timeout_ms=30_000)
    with pytest.raises(JanuslyApiError) as failure:
        client.runs.cancel(run_id=started["runId"])
    assert failure.value.status_code in (400, 409)

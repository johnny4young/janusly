"""Test for the recovery metrics resource."""

from __future__ import annotations

import pytest
from pytest_httpx import HTTPXMock

from janusly import JanuslyClient, ServiceTokenAuth


@pytest.fixture
def client() -> JanuslyClient:
    return JanuslyClient(
        base_url="https://api.test.janus.ly",
        org_id="test-org",
        auth=ServiceTokenAuth(token="test-token", user_id="test-user"),
    )


def test_get_metrics_threads_window_days(client: JanuslyClient, httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url="https://api.test.janus.ly/recovery/metrics?windowDays=7",
        json={"successRate": {"value": 0.95}, "windowDays": 7, "terminalRuns": 10},
    )
    result = client.recovery.get_metrics(window_days=7)
    assert result["windowDays"] == 7
    assert result["successRate"]["value"] == 0.95

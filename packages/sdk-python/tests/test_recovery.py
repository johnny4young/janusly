"""Test for the recovery metrics resource."""

from __future__ import annotations

import pytest
from pytest_httpx import HTTPXMock

from janusly import JanuslyClient, JanuslyProtocolError, ServiceTokenAuth
from helpers import v1


@pytest.fixture
def client() -> JanuslyClient:
    return JanuslyClient(
        base_url="https://api.test.janus.ly",
        org_id="test-org",
        auth=ServiceTokenAuth(token="test-token", user_id="test-user"),
    )


def test_get_metrics_threads_window_days(client: JanuslyClient, httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url="https://api.test.janus.ly/v1/recovery/metrics?windowDays=7",
        json=v1({
            "successRate": {"value": 0.95},
            "timeToFirstAction": {"value": 120, "display": "2m"},
            "recurrenceRate": {"value": 90, "display": "90.0%"},
            "windowDays": 7,
            "terminalRuns": 10,
        }),
    )
    result = client.recovery.get_metrics(window_days=7)
    assert result["windowDays"] == 7
    assert result["successRate"]["value"] == 0.95
    assert result["timeToFirstAction"] == {"value": 120, "display": "2m"}
    assert result["recurrenceRate"] == {"value": 90, "display": "90.0%"}


def test_get_metrics_rejects_a_drifted_v1_success(
    client: JanuslyClient,
    httpx_mock: HTTPXMock,
) -> None:
    httpx_mock.add_response(
        url="https://api.test.janus.ly/v1/recovery/metrics?windowDays=30",
        json={"windowDays": 30},
    )

    with pytest.raises(JanuslyProtocolError) as err:
        client.recovery.get_metrics()
    assert err.value.code == "invalid_response_envelope"


def test_get_metrics_rejects_a_non_json_v1_success(
    client: JanuslyClient,
    httpx_mock: HTTPXMock,
) -> None:
    httpx_mock.add_response(
        url="https://api.test.janus.ly/v1/recovery/metrics?windowDays=30",
        text="upstream proxy returned HTML",
        headers={"content-type": "text/plain"},
    )

    with pytest.raises(JanuslyProtocolError):
        client.recovery.get_metrics()

"""Tests for the opt-in retry layer (sync + async).

Mirrors the TS SDK's `withRetries` semantics: off by default, retries
`retry_on` statuses + network errors with exponential backoff, honours
`Retry-After` on a 429, and never retries a 4xx validation error.

Sync tests monkeypatch `time.sleep` (record-only, no wall-clock cost) so
they can also assert the delay; async tests use `backoff_ms=1` (negligible
real sleep) and assert behavior only.
"""

from __future__ import annotations

import time

import httpx
import pytest
from pytest_httpx import HTTPXMock

from janusly import (
    JanuslyAsyncClient,
    JanuslyClient,
    RetryConfig,
    ServiceTokenAuth,
)
from janusly.errors import JanuslyServerError, JanuslyValidationError
from helpers import v1

METRICS_URL = "https://api.test.janus.ly/v1/recovery/metrics?windowDays=30"


def _client(retry: RetryConfig | None = None) -> JanuslyClient:
    return JanuslyClient(
        base_url="https://api.test.janus.ly",
        org_id="test-org",
        auth=ServiceTokenAuth(token="t", user_id="u"),
        retry=retry,
    )


def _async_client(retry: RetryConfig | None = None) -> JanuslyAsyncClient:
    return JanuslyAsyncClient(
        base_url="https://api.test.janus.ly",
        org_id="test-org",
        auth=ServiceTokenAuth(token="t", user_id="u"),
        retry=retry,
    )


@pytest.fixture
def no_sleep(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    """Patch time.sleep to record delays without actually sleeping."""
    slept: list[float] = []
    monkeypatch.setattr(time, "sleep", lambda seconds: slept.append(seconds))
    return slept


# ── Sync ─────────────────────────────────────────────────────────────────


def test_sync_default_does_not_retry(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(url=METRICS_URL, status_code=503, json={"error": "down"})
    with pytest.raises(JanuslyServerError):
        _client().recovery.get_metrics()
    assert len(httpx_mock.get_requests()) == 1


def test_sync_retries_503_up_to_max_then_raises(
    httpx_mock: HTTPXMock, no_sleep: list[float]
) -> None:
    for _ in range(3):  # max_attempts=2 → 3 total attempts
        httpx_mock.add_response(url=METRICS_URL, status_code=503, json={"error": "down"})
    with pytest.raises(JanuslyServerError):
        _client(RetryConfig(max_attempts=2, backoff_ms=10)).recovery.get_metrics()
    assert len(httpx_mock.get_requests()) == 3
    # Exponential backoff in seconds: 10ms * 2**0, 10ms * 2**1.
    assert no_sleep == [0.01, 0.02]


def test_sync_retries_then_succeeds(httpx_mock: HTTPXMock, no_sleep: list[float]) -> None:
    httpx_mock.add_response(url=METRICS_URL, status_code=503, json={"error": "down"})
    httpx_mock.add_response(url=METRICS_URL, status_code=200, json=v1({"windowDays": 30}))
    result = _client(RetryConfig(max_attempts=3, backoff_ms=5)).recovery.get_metrics()
    assert result["windowDays"] == 30
    assert len(httpx_mock.get_requests()) == 2
    assert no_sleep == [0.005]


def test_sync_does_not_retry_validation_error(httpx_mock: HTTPXMock) -> None:
    """A 422 is not in retry_on → raised immediately, no retry."""
    httpx_mock.add_response(url=METRICS_URL, status_code=422, json={"error": "bad"})
    with pytest.raises(JanuslyValidationError):
        _client(RetryConfig(max_attempts=3, backoff_ms=1)).recovery.get_metrics()
    assert len(httpx_mock.get_requests()) == 1


def test_sync_honours_retry_after_on_429(
    httpx_mock: HTTPXMock, no_sleep: list[float]
) -> None:
    """A 429 carrying Retry-After uses that delay, not the exponential backoff."""
    httpx_mock.add_response(
        url=METRICS_URL,
        status_code=429,
        headers={"retry-after": "3"},
        json={"error": "slow down"},
    )
    httpx_mock.add_response(url=METRICS_URL, status_code=200, json=v1({"windowDays": 30}))
    result = _client(RetryConfig(max_attempts=1, backoff_ms=999)).recovery.get_metrics()
    assert result["windowDays"] == 30
    assert no_sleep == [3.0]  # Retry-After wins over backoff_ms.


def test_sync_retries_network_error(httpx_mock: HTTPXMock, no_sleep: list[float]) -> None:
    httpx_mock.add_exception(httpx.ConnectError("boom"), url=METRICS_URL)
    httpx_mock.add_response(url=METRICS_URL, status_code=200, json=v1({"windowDays": 30}))
    result = _client(RetryConfig(max_attempts=2, backoff_ms=1)).recovery.get_metrics()
    assert result["windowDays"] == 30
    assert len(httpx_mock.get_requests()) == 2


def test_sync_negative_backoff_clamps_to_retry_now(httpx_mock: HTTPXMock) -> None:
    """Defensive: a bad caller-provided backoff must not replace the HTTP error."""
    httpx_mock.add_response(url=METRICS_URL, status_code=503, json={"error": "down"})
    httpx_mock.add_response(url=METRICS_URL, status_code=200, json=v1({"windowDays": 30}))
    result = _client(RetryConfig(max_attempts=1, backoff_ms=-1)).recovery.get_metrics()
    assert result["windowDays"] == 30
    assert len(httpx_mock.get_requests()) == 2


# ── Async ────────────────────────────────────────────────────────────────


async def test_async_default_does_not_retry(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(url=METRICS_URL, status_code=503, json={"error": "down"})
    with pytest.raises(JanuslyServerError):
        await _async_client().recovery.get_metrics()
    assert len(httpx_mock.get_requests()) == 1


async def test_async_retries_then_succeeds(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(url=METRICS_URL, status_code=503, json={"error": "down"})
    httpx_mock.add_response(url=METRICS_URL, status_code=200, json=v1({"windowDays": 30}))
    result = await _async_client(RetryConfig(max_attempts=3, backoff_ms=1)).recovery.get_metrics()
    assert result["windowDays"] == 30
    assert len(httpx_mock.get_requests()) == 2


async def test_async_does_not_retry_validation_error(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(url=METRICS_URL, status_code=422, json={"error": "bad"})
    with pytest.raises(JanuslyValidationError):
        await _async_client(RetryConfig(max_attempts=3, backoff_ms=1)).recovery.get_metrics()
    assert len(httpx_mock.get_requests()) == 1


async def test_async_retries_network_error(httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_exception(httpx.ConnectError("boom"), url=METRICS_URL)
    httpx_mock.add_response(url=METRICS_URL, status_code=200, json=v1({"windowDays": 30}))
    result = await _async_client(RetryConfig(max_attempts=2, backoff_ms=1)).recovery.get_metrics()
    assert result["windowDays"] == 30
    assert len(httpx_mock.get_requests()) == 2


async def test_async_retries_503_up_to_max_then_raises(httpx_mock: HTTPXMock) -> None:
    """Async parity for the exhaust-all-retries path (sync covers the delays)."""
    for _ in range(3):  # max_attempts=2 → 3 total attempts
        httpx_mock.add_response(url=METRICS_URL, status_code=503, json={"error": "down"})
    with pytest.raises(JanuslyServerError):
        await _async_client(RetryConfig(max_attempts=2, backoff_ms=1)).recovery.get_metrics()
    assert len(httpx_mock.get_requests()) == 3

"""Tests for the error hierarchy + Retry-After parsing."""

from __future__ import annotations

from email.utils import formatdate

import pytest

from janusly.errors import (
    JanuslyApiError,
    JanuslyAuthError,
    JanuslyRateLimitError,
    JanuslyServerError,
    JanuslyValidationError,
    error_from_response,
    parse_retry_after_seconds,
)


@pytest.mark.parametrize(
    "status,expected_cls",
    [
        (401, JanuslyAuthError),
        (403, JanuslyAuthError),
        (400, JanuslyValidationError),
        (422, JanuslyValidationError),
        (429, JanuslyRateLimitError),
        (500, JanuslyServerError),
        (502, JanuslyServerError),
        (599, JanuslyServerError),
        (418, JanuslyApiError),
    ],
)
def test_status_to_subclass_mapping(status: int, expected_cls: type) -> None:
    err = error_from_response(
        status_code=status,
        response_body=None,
        parsed_envelope={"error": "boom", "code": "test_code"},
    )
    assert isinstance(err, expected_cls)
    assert err.status_code == status
    assert err.code == "test_code"
    assert str(err) == "boom"


def test_rate_limit_carries_retry_after_seconds_integer_form() -> None:
    err = error_from_response(
        status_code=429,
        response_body="rate limited",
        parsed_envelope={"error": "slow down"},
        retry_after_header="42",
    )
    assert isinstance(err, JanuslyRateLimitError)
    assert err.retry_after_seconds == 42.0


def test_rate_limit_retry_after_http_date_form() -> None:
    future_unix = 4_102_444_800  # 2100-01-01 — comfortably future
    http_date = formatdate(timeval=future_unix, usegmt=True)
    err = error_from_response(
        status_code=429,
        response_body="",
        parsed_envelope=None,
        retry_after_header=http_date,
    )
    assert isinstance(err, JanuslyRateLimitError)
    assert err.retry_after_seconds is not None
    assert err.retry_after_seconds > 0


def test_parse_retry_after_seconds_invalid_returns_none() -> None:
    assert parse_retry_after_seconds(None) is None
    assert parse_retry_after_seconds("") is None
    assert parse_retry_after_seconds("not-a-number-or-date") is None


def test_error_envelope_with_params_plumbing() -> None:
    err = error_from_response(
        status_code=422,
        response_body=None,
        parsed_envelope={
            "error": "validation failed",
            "code": "field_missing",
            "params": {"field": "workflowId"},
        },
    )
    assert err.code == "field_missing"
    assert err.params == {"field": "workflowId"}


def test_nested_v1_error_envelope_plumbing() -> None:
    err = error_from_response(
        status_code=422,
        response_body=None,
        parsed_envelope={
            "apiVersion": "v1",
            "requestId": "sdk-test",
            "error": {
                "message": "invalid request body",
                "code": "invalid_input",
                "params": {"field": "workflow"},
            },
        },
    )
    assert isinstance(err, JanuslyValidationError)
    assert str(err) == "invalid request body"
    assert err.code == "invalid_input"
    assert err.params == {"field": "workflow"}


def test_error_envelope_from_non_dict_falls_back_to_status() -> None:
    err = error_from_response(
        status_code=500,
        response_body="<html>oops</html>",
        parsed_envelope=None,
    )
    assert str(err) == "HTTP 500"
    assert err.response_body == "<html>oops</html>"
    assert err.code is None

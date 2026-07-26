"""
Typed error class hierarchy for the Janusly Python SDK.

Mirrors the TypeScript SDK's surface so a developer reading code in both
languages sees the same names + structure. Consumers can ``isinstance(err,
JanuslyRateLimitError)`` instead of switching on ``status_code``.

Status -> subclass mapping:
    401, 403            -> JanuslyAuthError
    400, 422            -> JanuslyValidationError
    429                 -> JanuslyRateLimitError (carries retry_after_seconds)
    500-599             -> JanuslyServerError
    anything else       -> JanuslyApiError (base)

JanuslyWebhookSignatureError is a sibling, NOT a subclass of
JanuslyApiError. Webhook verification doesn't go through HTTP — keeping
the hierarchies separate prevents accidental ``except JanuslyApiError``
swallowing of signature mismatches.

JanuslyTimeoutError is also standalone (not subclassed under
JanuslyApiError) because it's raised by client-side polling, not by an
HTTP response. Carries a stable code so callers can distinguish it
from real API errors.
"""

from __future__ import annotations

from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Literal, Optional


WebhookSignatureFailureReason = Literal[
    "malformed_header",
    "timestamp_skew",
    "signature_mismatch",
]


class JanuslyApiError(Exception):
    """Base class for HTTP errors surfaced by the Janusly SDK.

    Carries the structured envelope (``code`` + ``params``) from
    ``apps/api/src/error-codes.ts`` so translation helpers downstream
    can resolve catalog keys. ``response_body`` keeps the raw text the
    server emitted (may be ``None`` if the response was empty).
    """

    status_code: int
    code: Optional[str]
    params: Optional[dict[str, Any]]
    response_body: Optional[str]

    def __init__(
        self,
        message: str,
        *,
        status_code: int,
        code: Optional[str] = None,
        params: Optional[dict[str, Any]] = None,
        response_body: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.params = params
        self.response_body = response_body


class JanuslyAuthError(JanuslyApiError):
    """Raised on 401 / 403. Missing or rejected auth header."""


class JanuslyValidationError(JanuslyApiError):
    """Raised on 400 / 422. Request body shape rejected by the server."""


class JanuslyRateLimitError(JanuslyApiError):
    """Raised on 429. Carries ``retry_after_seconds`` parsed from the header.

    Callers handling 429 manually should ``time.sleep(err.retry_after_seconds)``
    before retrying when ``retry_after_seconds`` is not ``None``.
    """

    retry_after_seconds: Optional[float]

    def __init__(
        self,
        message: str,
        *,
        status_code: int,
        code: Optional[str] = None,
        params: Optional[dict[str, Any]] = None,
        response_body: Optional[str] = None,
        retry_after_seconds: Optional[float] = None,
    ) -> None:
        super().__init__(
            message,
            status_code=status_code,
            code=code,
            params=params,
            response_body=response_body,
        )
        self.retry_after_seconds = retry_after_seconds


class JanuslyServerError(JanuslyApiError):
    """Raised on 5xx. Server-side failure, generally retryable."""


class JanuslyProtocolError(JanuslyApiError):
    """Raised when a successful ``/v1`` response has an invalid envelope."""


class JanuslyTimeoutError(Exception):
    """Raised by client-side polling when the wall-clock deadline elapses.

    Distinct from JanuslyApiError because no HTTP response triggered it —
    the SDK gave up waiting. The ``code`` field is always
    ``"polling_timeout"`` for stable consumer-side switch logic.
    """

    code: str = "polling_timeout"


class JanuslyWebhookSignatureError(Exception):
    """Raised by :func:`janusly.webhooks.verify_signature` on failure.

    The ``reason`` field is a closed enum so consumers can branch on the
    specific failure mode for logging or alerting without parsing the
    message text.
    """

    reason: WebhookSignatureFailureReason

    def __init__(self, message: str, reason: WebhookSignatureFailureReason) -> None:
        super().__init__(message)
        self.reason = reason


def parse_retry_after_seconds(raw: Optional[str]) -> Optional[float]:
    """Parse the ``Retry-After`` header per RFC 9110.

    Accepts both forms:
    * decimal seconds count (``"5"``)
    * HTTP-date (``"Wed, 21 Oct 2026 07:28:00 GMT"``)

    Returns ``None`` when neither shape parses. HTTP-dates in the past
    map to ``0.0`` (retry immediately) rather than a negative number —
    operators sleeping on the value should never sleep "backwards".
    """
    if raw is None:
        return None
    trimmed = raw.strip()
    if not trimmed:
        return None
    # Numeric form (RFC 9110 section 10.2.3 — "delta-seconds"). Treat as
    # immediately-actionable when the server signals 0 or negative
    # (some implementations send -1 to mean "retry now"); never return
    # a negative value to the caller — they'd sleep "backwards".
    try:
        value = float(trimmed)
    except ValueError:
        value = None
    if value is not None:
        return max(value, 0.0)
    try:
        when = parsedate_to_datetime(trimmed)
    except (TypeError, ValueError):
        return None
    if when is None:
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    delta = (when - datetime.now(timezone.utc)).total_seconds()
    if delta <= 0:
        return 0.0
    return delta


def error_from_response(
    status_code: int,
    response_body: Optional[str],
    parsed_envelope: Optional[dict[str, Any]],
    retry_after_header: Optional[str] = None,
) -> JanuslyApiError:
    """Map an HTTP response into the right typed error subclass.

    ``parsed_envelope`` is the JSON-decoded body when the response was
    JSON (defensive: a non-JSON body falls back to ``None`` and the
    helper still produces a sensible error using the status text).

    The caller is responsible for the JSON decode + ``response_body``
    fallback; this function is a pure mapper, not an HTTP reader.
    """
    envelope = _extract_envelope(parsed_envelope)
    message = envelope.get("error") or f"HTTP {status_code}"
    code = envelope.get("code")
    params = envelope.get("params")
    common: dict[str, Any] = {
        "status_code": status_code,
        "code": code,
        "params": params,
        "response_body": response_body,
    }
    if status_code in (401, 403):
        return JanuslyAuthError(message, **common)
    if status_code in (400, 422):
        return JanuslyValidationError(message, **common)
    if status_code == 429:
        return JanuslyRateLimitError(
            message,
            retry_after_seconds=parse_retry_after_seconds(retry_after_header),
            **common,
        )
    if 500 <= status_code < 600:
        return JanuslyServerError(message, **common)
    return JanuslyApiError(message, **common)


def _extract_envelope(body: Any) -> dict[str, Any]:
    """Defensive: pull ``{error, code, params}`` out of an unknown body."""
    if not isinstance(body, dict):
        return {}
    out: dict[str, Any] = {}
    error = body.get("error")
    if isinstance(error, str):
        out["error"] = error
    elif isinstance(error, dict):
        message = error.get("message")
        nested_code = error.get("code")
        nested_params = error.get("params")
        if isinstance(message, str):
            out["error"] = message
        if isinstance(nested_code, str):
            out["code"] = nested_code
        if isinstance(nested_params, dict):
            out["params"] = nested_params
    code = body.get("code")
    if isinstance(code, str):
        out["code"] = code
    params = body.get("params")
    if isinstance(params, dict):
        out["params"] = params
    return out


__all__ = [
    "JanuslyApiError",
    "JanuslyAuthError",
    "JanuslyValidationError",
    "JanuslyRateLimitError",
    "JanuslyServerError",
    "JanuslyProtocolError",
    "JanuslyTimeoutError",
    "JanuslyWebhookSignatureError",
    "WebhookSignatureFailureReason",
    "parse_retry_after_seconds",
    "error_from_response",
]

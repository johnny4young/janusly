"""
Internal httpx wrapper used by every resource. Composes the standard
headers (``Authorization``, ``x-org-id``, ``accept``, ``user-agent``,
plus ``x-user-id`` in service-token mode), maps HTTP responses to the
typed error hierarchy, and parses the API's structured error envelope
(``{ error, code, params }`` from ``apps/api/src/error-codes.ts``)
defensively — a non-JSON response body falls back to the raw text
rather than throwing a parse error.

The header injection guard at request time rejects user-supplied custom
headers that collide with internal ones — without this guard, a
``custom_headers={"x-org-id": "other-org"}`` could authenticate as a
different tenant.

This module is internal — operators use :class:`JanuslyClient` from
``janusly.client`` instead.
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional, Union

import httpx

from .errors import (
    JanuslyApiError,
    JanuslyProtocolError,
    JanuslyRateLimitError,
    error_from_response,
)

DEFAULT_TIMEOUT_SECONDS = 30.0

# Internal header names. User-supplied headers that collide with these
# are rejected at request time with a ValueError.
_RESERVED_HEADERS = frozenset(
    name.lower()
    for name in (
        "Authorization",
        "Accept",
        "User-Agent",
        "x-org-id",
        "x-user-id",
        "Content-Type",
    )
)


@dataclass(frozen=True)
class ServiceTokenAuth:
    """Service-token auth (recommended for server-to-server)."""

    token: str
    user_id: str = "sdk-user"


@dataclass(frozen=True)
class BearerAuth:
    """Bearer auth (Supabase JWT or equivalent user-issued token)."""

    token: str


AuthLike = Union[ServiceTokenAuth, BearerAuth]


@dataclass(frozen=True)
class RetryConfig:
    """Opt-in retry layer config. Off by default for predictability.

    Mirrors the TypeScript SDK's ``JanuslyRetryConfig``. A transient
    ``retry_on`` status — or a network / timeout error — is retried with
    exponential backoff (``backoff_ms * 2**attempt``); a 429 that carries a
    ``Retry-After`` header uses that delay instead. A 4xx validation error
    (a status NOT in ``retry_on``) is never retried.

    ``retry_on`` is a tuple (not a list) so the frozen dataclass default
    stays immutable.
    """

    #: Additional attempts AFTER the first. 0 (the default) = no retries.
    max_attempts: int = 0
    #: Initial backoff in milliseconds; exponential (``backoff_ms * 2**attempt``).
    backoff_ms: int = 200
    #: HTTP status codes that trigger a retry.
    retry_on: tuple[int, ...] = (429, 502, 503, 504)


@dataclass(frozen=True)
class ClientConfig:
    """Immutable config snapshot the resource classes share."""

    base_url: str
    org_id: str
    auth: AuthLike
    timeout: float
    user_agent: str
    #: Opt-in retry layer. ``None`` (the default) = single attempt, no retries.
    retry: Optional[RetryConfig] = None


def make_config(
    *,
    base_url: str,
    org_id: str,
    auth: AuthLike,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    user_agent_suffix: str = "",
    retry: Optional[RetryConfig] = None,
) -> ClientConfig:
    """Build the immutable config that ``JanuslyClient`` keeps for the
    lifetime of the client. Strips trailing slashes from ``base_url`` so
    the per-request URL composition stays predictable.
    """
    normalized_base = base_url.rstrip("/")
    base_user_agent = "janusly-python/0.0.1"
    suffix = user_agent_suffix.strip()
    user_agent = f"{base_user_agent} {suffix}" if suffix else base_user_agent
    return ClientConfig(
        base_url=normalized_base,
        org_id=org_id,
        auth=auth,
        timeout=timeout,
        user_agent=user_agent,
        retry=retry,
    )


def build_headers(
    config: ClientConfig,
    extra: Optional[dict[str, str]] = None,
) -> dict[str, str]:
    """Compose the headers for one request.

    Always includes ``Authorization``, ``Accept``, ``User-Agent``,
    ``x-org-id``. Adds ``x-user-id`` for service-token mode only.
    Rejects user-supplied headers that collide with any of the above
    via :class:`ValueError` (header injection defense).
    """
    headers: dict[str, str] = {
        "Authorization": f"Bearer {config.auth.token}",
        "Accept": "application/json",
        "User-Agent": config.user_agent,
        "x-org-id": config.org_id,
    }
    if isinstance(config.auth, ServiceTokenAuth):
        headers["x-user-id"] = config.auth.user_id
    if extra:
        for raw_name, raw_value in extra.items():
            if raw_name.lower() in _RESERVED_HEADERS:
                raise ValueError(
                    f"custom header {raw_name!r} collides with a reserved header"
                )
            headers[raw_name] = raw_value
    return headers


def request(
    config: ClientConfig,
    *,
    method: str,
    path: str,
    json_body: Any = None,
    extra_headers: Optional[dict[str, str]] = None,
    timeout: Optional[float] = None,
) -> httpx.Response:
    """Issue one request through the shared httpx Client.

    Returns the raw :class:`httpx.Response` for 2xx responses. Raises
    the right :class:`JanuslyApiError` subclass for non-2xx — the
    caller never sees a 4xx/5xx response object.

    Per-call ``timeout`` overrides the client-wide default. ``json_body``
    is JSON-encoded server-side by httpx and the ``Content-Type`` header
    is set automatically; don't pass it via ``extra_headers``.

    When ``config.retry`` is set, a transient failure is retried with
    backoff; headers are composed ONCE up front (the injection guard is
    deterministic and must never be retried).
    """
    url = f"{config.base_url}{path}"
    headers = build_headers(config, extra_headers)
    effective_timeout = timeout if timeout is not None else config.timeout

    def attempt() -> httpx.Response:
        with httpx.Client(timeout=effective_timeout) as client:
            response = client.request(
                method=method,
                url=url,
                headers=headers,
                json=json_body,
            )
        return _raise_for_status(response)

    return _with_retries(attempt, config.retry)


async def async_request(
    config: ClientConfig,
    *,
    method: str,
    path: str,
    json_body: Any = None,
    extra_headers: Optional[dict[str, str]] = None,
    timeout: Optional[float] = None,
) -> httpx.Response:
    """Async sibling of :func:`request`.

    Issues one request through a fresh :class:`httpx.AsyncClient` (the
    transport is stateless per-call, mirroring the sync path — no shared
    pool). Same header composition, same per-call ``timeout`` override,
    and the SAME typed error mapping via :func:`_raise_for_status`, so an
    identical response yields an identical :class:`JanuslyApiError`
    subclass on either path. Returns the raw 2xx :class:`httpx.Response`;
    raises for non-2xx. Honours ``config.retry`` via :func:`_with_retries_async`.
    """
    url = f"{config.base_url}{path}"
    headers = build_headers(config, extra_headers)
    effective_timeout = timeout if timeout is not None else config.timeout

    async def attempt() -> httpx.Response:
        async with httpx.AsyncClient(timeout=effective_timeout) as client:
            response = await client.request(
                method=method,
                url=url,
                headers=headers,
                json=json_body,
            )
        return _raise_for_status(response)

    return await _with_retries_async(attempt, config.retry)


def _should_retry(error: Exception, retry: RetryConfig) -> bool:
    """Decide whether ``error`` is retryable under ``retry``.

    A :class:`JanuslyApiError` is retried only when its ``status_code`` is in
    ``retry.retry_on`` (so 4xx validation errors are NOT retried). Any
    :class:`httpx.HTTPError` (transport / network / timeout) is retried. Every
    other exception propagates immediately — we never blindly retry an
    arbitrary error (e.g. the deterministic header-injection ``ValueError``).
    """
    if isinstance(error, JanuslyApiError):
        return error.status_code in retry.retry_on
    return isinstance(error, httpx.HTTPError)


def _retry_delay_seconds(error: Exception, retry: RetryConfig, attempt: int) -> float:
    """Seconds to wait before the next attempt: the server's ``Retry-After``
    on a 429 that carries it, else exponential backoff
    (``backoff_ms * 2**attempt``)."""
    if isinstance(error, JanuslyRateLimitError) and error.retry_after_seconds is not None:
        return max(0.0, error.retry_after_seconds)
    return max(0.0, float(retry.backoff_ms * (2 ** attempt)) / 1000.0)


def _with_retries(
    attempt_fn: Callable[[], httpx.Response],
    retry: Optional[RetryConfig],
) -> httpx.Response:
    """Run ``attempt_fn`` with the opt-in retry policy.

    When ``retry`` is ``None`` (or ``max_attempts <= 0``) the thunk runs
    exactly once and any error propagates — byte-for-byte the no-retry
    behavior. Otherwise a retryable failure (:func:`_should_retry`) sleeps
    (:func:`_retry_delay_seconds`) and re-runs, up to ``max_attempts`` extra
    times, then re-raises the last error.
    """
    max_attempts = retry.max_attempts if retry else 0
    attempt = 0
    while True:
        try:
            return attempt_fn()
        except (JanuslyApiError, httpx.HTTPError) as error:
            if attempt >= max_attempts or retry is None or not _should_retry(error, retry):
                raise
            time.sleep(_retry_delay_seconds(error, retry, attempt))
            attempt += 1


async def _with_retries_async(
    attempt_fn: Callable[[], Awaitable[httpx.Response]],
    retry: Optional[RetryConfig],
) -> httpx.Response:
    """Async sibling of :func:`_with_retries` (``await asyncio.sleep`` between
    attempts). Task cancellation (:class:`asyncio.CancelledError`, a
    ``BaseException``) propagates out of the sleep and is never retried."""
    max_attempts = retry.max_attempts if retry else 0
    attempt = 0
    while True:
        try:
            return await attempt_fn()
        except (JanuslyApiError, httpx.HTTPError) as error:
            if attempt >= max_attempts or retry is None or not _should_retry(error, retry):
                raise
            await asyncio.sleep(_retry_delay_seconds(error, retry, attempt))
            attempt += 1


def _raise_for_status(response: httpx.Response) -> httpx.Response:
    """Return ``response`` unchanged on 2xx; otherwise map it to the right
    :class:`JanuslyApiError` subclass.

    Shared by the sync :func:`request` and the async :func:`async_request`
    so both transports produce byte-identical errors from identical
    responses. A non-JSON error body falls back to the raw text rather
    than throwing a parse error.
    """
    if 200 <= response.status_code < 300:
        return response
    body_text = response.text or None
    parsed_envelope: Optional[dict[str, Any]] = None
    if body_text:
        try:
            parsed = json.loads(body_text)
        except (json.JSONDecodeError, ValueError):
            parsed = None
        if isinstance(parsed, dict):
            parsed_envelope = parsed
    raise error_from_response(
        status_code=response.status_code,
        response_body=body_text,
        parsed_envelope=parsed_envelope,
        retry_after_header=response.headers.get("retry-after"),
    )


def response_json(response: httpx.Response) -> Any:
    """Decode JSON and unwrap the stable envelope for ``/v1`` responses.

    Legacy routes retain their raw JSON shape. Stable success responses fail
    closed when ``apiVersion``, ``requestId``, or ``data`` is missing so the
    typed clients never silently accept server contract drift.
    """
    versioned = response.request.url.path.startswith("/v1/")
    try:
        payload = response.json()
    except (json.JSONDecodeError, ValueError):
        if not versioned:
            raise
        raise _protocol_error(response) from None
    if not versioned:
        return payload
    if (
        not isinstance(payload, dict)
        or payload.get("apiVersion") != "v1"
        or not isinstance(payload.get("requestId"), str)
        or not payload.get("requestId")
        or "data" not in payload
    ):
        raise _protocol_error(response)
    return payload["data"]


def _protocol_error(response: httpx.Response) -> JanuslyProtocolError:
    return JanuslyProtocolError(
        "Invalid Janusly v1 response envelope",
        status_code=response.status_code,
        code="invalid_response_envelope",
        response_body=response.text or None,
    )


__all__ = [
    "AuthLike",
    "BearerAuth",
    "ClientConfig",
    "RetryConfig",
    "ServiceTokenAuth",
    "async_request",
    "build_headers",
    "make_config",
    "request",
    "response_json",
]

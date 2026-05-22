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

import json
from dataclasses import dataclass
from typing import Any, Optional, Union

import httpx

from .errors import error_from_response

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
class ClientConfig:
    """Immutable config snapshot the resource classes share."""

    base_url: str
    org_id: str
    auth: AuthLike
    timeout: float
    user_agent: str


def make_config(
    *,
    base_url: str,
    org_id: str,
    auth: AuthLike,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    user_agent_suffix: str = "",
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
    """
    url = f"{config.base_url}{path}"
    headers = build_headers(config, extra_headers)
    effective_timeout = timeout if timeout is not None else config.timeout
    with httpx.Client(timeout=effective_timeout) as client:
        response = client.request(
            method=method,
            url=url,
            headers=headers,
            json=json_body,
        )
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


__all__ = [
    "AuthLike",
    "BearerAuth",
    "ClientConfig",
    "ServiceTokenAuth",
    "build_headers",
    "make_config",
    "request",
]

"""
Janusly Python SDK — public re-exports.

Two import paths the operator can use:

* Full client (pulls in httpx)::

      from janusly import JanuslyClient, ServiceTokenAuth

* Webhook verifier only (stdlib-only — no httpx import)::

      from janusly.webhooks import verify_signature

The two paths are deliberately split so a Lambda receiver that only
verifies inbound webhooks doesn't pay the httpx dep cost. The webhook
helper module imports nothing beyond Python's stdlib.

Note: this ``__init__`` eagerly re-exports only the error classes (which
have no httpx dependency themselves) and the verifier name for
convenience. Client/auth symbols are lazy-loaded via ``__getattr__`` so
``from janusly.webhooks import verify_signature`` keeps the lightweight
stdlib-only import path; ``from janusly import JanuslyClient`` still
works and loads httpx only when the client surface is requested.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .errors import (
    JanuslyApiError,
    JanuslyAuthError,
    JanuslyRateLimitError,
    JanuslyServerError,
    JanuslyTimeoutError,
    JanuslyValidationError,
    JanuslyWebhookSignatureError,
    WebhookSignatureFailureReason,
)
from .webhooks import verify_signature

if TYPE_CHECKING:
    from ._http import BearerAuth, ServiceTokenAuth
    from .async_client import (
        AsyncRecoveryResource,
        AsyncReportsResource,
        AsyncRunsResource,
        JanuslyAsyncClient,
    )
    from .client import (
        JanuslyClient,
        RecoveryResource,
        ReportsResource,
        RunsResource,
        WebhooksResource,
    )

__version__ = "0.0.1"

_LAZY_EXPORTS = {
    "BearerAuth": ("._http", "BearerAuth"),
    "ServiceTokenAuth": ("._http", "ServiceTokenAuth"),
    "JanuslyClient": (".client", "JanuslyClient"),
    "RecoveryResource": (".client", "RecoveryResource"),
    "ReportsResource": (".client", "ReportsResource"),
    "RunsResource": (".client", "RunsResource"),
    "WebhooksResource": (".client", "WebhooksResource"),
    "JanuslyAsyncClient": (".async_client", "JanuslyAsyncClient"),
    "AsyncRecoveryResource": (".async_client", "AsyncRecoveryResource"),
    "AsyncReportsResource": (".async_client", "AsyncReportsResource"),
    "AsyncRunsResource": (".async_client", "AsyncRunsResource"),
}


def __getattr__(name: str) -> Any:
    """Lazy-load client/auth re-exports on first access.

    This keeps ``janusly.webhooks`` importable without importing ``httpx``
    while preserving the convenient top-level ``from janusly import
    JanuslyClient`` surface.
    """
    target = _LAZY_EXPORTS.get(name)
    if target is None:
        raise AttributeError(f"module 'janusly' has no attribute {name!r}")
    module_name, attr_name = target
    from importlib import import_module

    value = getattr(import_module(module_name, __name__), attr_name)
    globals()[name] = value
    return value


def __dir__() -> list[str]:
    return sorted(set(globals()) | set(__all__))

__all__ = [
    # Client + auth
    "BearerAuth",
    "JanuslyClient",
    "JanuslyAsyncClient",
    "RecoveryResource",
    "ReportsResource",
    "RunsResource",
    "AsyncRecoveryResource",
    "AsyncReportsResource",
    "AsyncRunsResource",
    "ServiceTokenAuth",
    "WebhooksResource",
    # Errors
    "JanuslyApiError",
    "JanuslyAuthError",
    "JanuslyRateLimitError",
    "JanuslyServerError",
    "JanuslyTimeoutError",
    "JanuslyValidationError",
    "JanuslyWebhookSignatureError",
    "WebhookSignatureFailureReason",
    # Webhook verifier (also at janusly.webhooks for stdlib-only import)
    "verify_signature",
    "__version__",
]

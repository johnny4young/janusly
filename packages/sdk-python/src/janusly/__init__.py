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

Note: this ``__init__`` re-exports the error classes (which have no
httpx dependency themselves) and the verifier name for convenience.
Importing ``janusly`` directly DOES load ``janusly.client``, which
loads httpx. Receivers that want the lightweight path MUST use the
``from janusly.webhooks import verify_signature`` form documented
above and in the README.
"""

from __future__ import annotations

from .client import (
    BearerAuth,
    JanuslyClient,
    RecoveryResource,
    ReportsResource,
    RunsResource,
    ServiceTokenAuth,
    WebhooksResource,
)
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

__version__ = "0.0.1"

__all__ = [
    # Client + auth
    "BearerAuth",
    "JanuslyClient",
    "RecoveryResource",
    "ReportsResource",
    "RunsResource",
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

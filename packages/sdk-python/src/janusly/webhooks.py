"""
Stripe-style HMAC-SHA256 webhook verifier — stdlib only.

Mirrors the TypeScript SDK's ``verifySignature`` byte-for-byte:

* Header shape: ``x-janusly-signature: t=<unix-seconds>,v1=<hex>``
* Signed payload: ``f"{unix_seconds}.{body}"`` (UTF-8 bytes)
* Algorithm: HMAC-SHA256
* Default clock-skew tolerance: ±300 seconds (5 minutes)
* Constant-time comparison via :func:`hmac.compare_digest`

**Zero runtime dependencies on this module.** Imports only Python stdlib
(``hmac``, ``hashlib``, ``time``). A Lambda receiver that only verifies
webhooks can ``from janusly.webhooks import verify_signature`` without
pulling in ``httpx`` — the heavy parts live in ``janusly.client`` and are
only loaded when the user explicitly imports them.

Receivers MUST pass the RAW request body — not a parsed JSON object.
Re-serializing a parsed object produces different bytes (key order,
whitespace) and breaks the HMAC.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import time
from typing import Union

from .errors import JanuslyWebhookSignatureError

# Default skew tolerance: ±5 minutes (matches Stripe + WorkOS conventions).
DEFAULT_TOLERANCE_SECONDS = 300

_HEX_RE = re.compile(r"^[0-9a-fA-F]+$")


def verify_signature(
    *,
    body: Union[bytes, str],
    signature_header: str,
    secret: str,
    tolerance_seconds: int = DEFAULT_TOLERANCE_SECONDS,
    now_seconds: int | None = None,
) -> dict[str, int]:
    """Verify a Janusly-signed inbound webhook.

    Args:
        body: Raw bytes (or string) of the HTTP request body. Pass the
            bytes captured BEFORE parsing — re-serializing a parsed JSON
            object produces different bytes and breaks the HMAC.
        signature_header: Value of the ``x-janusly-signature`` header.
        secret: Shared secret known by both sender + receiver.
        tolerance_seconds: Max allowed clock skew in seconds. Default 300
            (5 minutes). Pass 0 to disable the check (rarely what you
            want — clock skew is the most common false-positive when
            disabled, but a long-lived offline test might need it).
        now_seconds: Injectable "current time" in unix seconds. Tests
            pass a fixed value; production omits and uses :func:`time.time`.

    Returns:
        ``{"timestamp": int}`` on success — the unix-seconds timestamp
        parsed from the signature header.

    Raises:
        JanuslyWebhookSignatureError: with typed ``reason`` field —
            ``"malformed_header"`` (header missing ``t=`` or ``v1=`` parts),
            ``"timestamp_skew"`` (timestamp outside tolerance window), or
            ``"signature_mismatch"`` (HMAC did not match — tampered body
            or wrong secret).
    """
    parsed_timestamp, parsed_signature_hex = _parse_signature_header(signature_header)
    tolerance = tolerance_seconds
    now = now_seconds if now_seconds is not None else int(time.time())

    if tolerance > 0:
        skew = abs(now - parsed_timestamp)
        if skew > tolerance:
            raise JanuslyWebhookSignatureError(
                f"webhook timestamp outside tolerance window (skew={skew}s, tolerance={tolerance}s)",
                "timestamp_skew",
            )

    body_bytes = body.encode("utf-8") if isinstance(body, str) else body
    signed_payload = f"{parsed_timestamp}.".encode("utf-8") + body_bytes
    expected_hex = hmac.new(
        secret.encode("utf-8"),
        signed_payload,
        hashlib.sha256,
    ).hexdigest()

    if not _constant_time_hex_equal(parsed_signature_hex, expected_hex):
        raise JanuslyWebhookSignatureError(
            "webhook signature did not match",
            "signature_mismatch",
        )

    return {"timestamp": parsed_timestamp}


def _parse_signature_header(header: str) -> tuple[int, str]:
    """Parse ``t=<unix>,v1=<hex>`` into ``(timestamp, hex)``.

    Tolerates whitespace around segments. Raises
    :class:`JanuslyWebhookSignatureError` with ``reason="malformed_header"``
    when either field is missing OR doesn't parse to its expected type.
    """
    if not isinstance(header, str) or not header:
        raise JanuslyWebhookSignatureError(
            "webhook signature header is empty",
            "malformed_header",
        )
    timestamp: int | None = None
    signature_hex: str | None = None
    for raw_part in header.split(","):
        part = raw_part.strip()
        if not part:
            continue
        eq_idx = part.find("=")
        if eq_idx <= 0:
            continue
        key = part[:eq_idx].strip()
        value = part[eq_idx + 1 :].strip()
        if key == "t":
            try:
                parsed = int(value, 10)
            except ValueError:
                continue
            if parsed >= 0:
                timestamp = parsed
        elif key == "v1":
            if _HEX_RE.match(value):
                signature_hex = value.lower()
    if timestamp is None or signature_hex is None:
        raise JanuslyWebhookSignatureError(
            "webhook signature header missing t= or v1= part",
            "malformed_header",
        )
    return timestamp, signature_hex


def _constant_time_hex_equal(a: str, b: str) -> bool:
    """Constant-time hex string equality.

    Delegates to :func:`hmac.compare_digest` which is documented to
    handle length-mismatch inputs by returning ``False`` without a
    content-based short-circuit. We deliberately do NOT add a length
    guard ahead of the compare — an explicit early-return there would
    let an attacker distinguish wrong-length from same-length-but-wrong
    inputs via timing, even though the SHA-256 hex length is a public
    property of the algorithm.
    """
    return hmac.compare_digest(a.encode("ascii"), b.encode("ascii"))


__all__ = ["verify_signature", "DEFAULT_TOLERANCE_SECONDS"]

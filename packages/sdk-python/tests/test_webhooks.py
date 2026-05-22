"""Tests for the stdlib-only HMAC webhook verifier.

The reference HMAC value below was computed independently by the Node
engine's signing function (``signWebhookPayload`` in
``packages/engine/src/integration-tools.ts``) with the same
``(secret, body, timestamp)`` triple. If the two implementations ever
drift, this test pin breaks first.
"""

from __future__ import annotations

import pytest

from janusly.errors import JanuslyWebhookSignatureError
from janusly.webhooks import verify_signature

REFERENCE_SECRET = "test-secret"
REFERENCE_BODY = b'{"event":"run.completed"}'
REFERENCE_TIMESTAMP = 1700000000
REFERENCE_SIG_HEX = "e9df1d6069fcd21baca8aa13029d247d5c588c3da74f2cff426e84eea2c1b426"
REFERENCE_HEADER = f"t={REFERENCE_TIMESTAMP},v1={REFERENCE_SIG_HEX}"


def test_valid_signature_with_bytes_body_returns_timestamp() -> None:
    """Round-trip the reference Node engine signature through the Python verifier."""
    result = verify_signature(
        body=REFERENCE_BODY,
        signature_header=REFERENCE_HEADER,
        secret=REFERENCE_SECRET,
        now_seconds=REFERENCE_TIMESTAMP,
    )
    assert result == {"timestamp": REFERENCE_TIMESTAMP}


def test_valid_signature_accepts_str_body() -> None:
    """Body passed as str produces the same HMAC as bytes (UTF-8 encode)."""
    result = verify_signature(
        body=REFERENCE_BODY.decode("utf-8"),
        signature_header=REFERENCE_HEADER,
        secret=REFERENCE_SECRET,
        now_seconds=REFERENCE_TIMESTAMP,
    )
    assert result == {"timestamp": REFERENCE_TIMESTAMP}


def test_signature_mismatch_on_tampered_body() -> None:
    """A flipped byte in the body breaks the HMAC."""
    with pytest.raises(JanuslyWebhookSignatureError) as err:
        verify_signature(
            body=b'{"event":"run.tampered"}',  # different body
            signature_header=REFERENCE_HEADER,
            secret=REFERENCE_SECRET,
            now_seconds=REFERENCE_TIMESTAMP,
        )
    assert err.value.reason == "signature_mismatch"


def test_signature_mismatch_on_wrong_secret() -> None:
    """A different secret breaks the HMAC."""
    with pytest.raises(JanuslyWebhookSignatureError) as err:
        verify_signature(
            body=REFERENCE_BODY,
            signature_header=REFERENCE_HEADER,
            secret="wrong-secret",
            now_seconds=REFERENCE_TIMESTAMP,
        )
    assert err.value.reason == "signature_mismatch"


def test_timestamp_skew_past() -> None:
    """A timestamp older than the tolerance window rejects."""
    with pytest.raises(JanuslyWebhookSignatureError) as err:
        verify_signature(
            body=REFERENCE_BODY,
            signature_header=REFERENCE_HEADER,
            secret=REFERENCE_SECRET,
            now_seconds=REFERENCE_TIMESTAMP + 1000,  # 1000s in the future = stale
        )
    assert err.value.reason == "timestamp_skew"


def test_timestamp_skew_future() -> None:
    """A timestamp in the (operator-clock) future beyond tolerance rejects."""
    with pytest.raises(JanuslyWebhookSignatureError) as err:
        verify_signature(
            body=REFERENCE_BODY,
            signature_header=REFERENCE_HEADER,
            secret=REFERENCE_SECRET,
            now_seconds=REFERENCE_TIMESTAMP - 1000,  # operator clock is way behind
        )
    assert err.value.reason == "timestamp_skew"


def test_configurable_tolerance() -> None:
    """A tighter tolerance rejects what the default 300s tolerance allows."""
    # 200s in the future would PASS at default 300s tolerance but FAIL at 60s.
    with pytest.raises(JanuslyWebhookSignatureError) as err:
        verify_signature(
            body=REFERENCE_BODY,
            signature_header=REFERENCE_HEADER,
            secret=REFERENCE_SECRET,
            tolerance_seconds=60,
            now_seconds=REFERENCE_TIMESTAMP + 200,
        )
    assert err.value.reason == "timestamp_skew"


def test_tolerance_zero_disables_skew_check() -> None:
    """``tolerance_seconds=0`` accepts any timestamp (rare but explicit)."""
    result = verify_signature(
        body=REFERENCE_BODY,
        signature_header=REFERENCE_HEADER,
        secret=REFERENCE_SECRET,
        tolerance_seconds=0,
        now_seconds=REFERENCE_TIMESTAMP + 999_999_999,
    )
    assert result["timestamp"] == REFERENCE_TIMESTAMP


def test_malformed_header_empty() -> None:
    with pytest.raises(JanuslyWebhookSignatureError) as err:
        verify_signature(
            body=REFERENCE_BODY,
            signature_header="",
            secret=REFERENCE_SECRET,
            now_seconds=REFERENCE_TIMESTAMP,
        )
    assert err.value.reason == "malformed_header"


def test_malformed_header_missing_t() -> None:
    with pytest.raises(JanuslyWebhookSignatureError) as err:
        verify_signature(
            body=REFERENCE_BODY,
            signature_header=f"v1={REFERENCE_SIG_HEX}",
            secret=REFERENCE_SECRET,
            now_seconds=REFERENCE_TIMESTAMP,
        )
    assert err.value.reason == "malformed_header"


def test_malformed_header_missing_v1() -> None:
    with pytest.raises(JanuslyWebhookSignatureError) as err:
        verify_signature(
            body=REFERENCE_BODY,
            signature_header=f"t={REFERENCE_TIMESTAMP}",
            secret=REFERENCE_SECRET,
            now_seconds=REFERENCE_TIMESTAMP,
        )
    assert err.value.reason == "malformed_header"


def test_malformed_header_non_hex_v1() -> None:
    with pytest.raises(JanuslyWebhookSignatureError) as err:
        verify_signature(
            body=REFERENCE_BODY,
            signature_header=f"t={REFERENCE_TIMESTAMP},v1=not-hex-at-all",
            secret=REFERENCE_SECRET,
            now_seconds=REFERENCE_TIMESTAMP,
        )
    assert err.value.reason == "malformed_header"


def test_constant_time_compare_on_length_mismatch() -> None:
    """A signature of wrong length must reject as signature_mismatch.

    Confirms the length-mismatch defense in
    :func:`janusly.webhooks._constant_time_hex_equal` doesn't crash and
    doesn't short-circuit to True.
    """
    short_sig = REFERENCE_SIG_HEX[: len(REFERENCE_SIG_HEX) // 2]
    with pytest.raises(JanuslyWebhookSignatureError) as err:
        verify_signature(
            body=REFERENCE_BODY,
            signature_header=f"t={REFERENCE_TIMESTAMP},v1={short_sig}",
            secret=REFERENCE_SECRET,
            now_seconds=REFERENCE_TIMESTAMP,
        )
    assert err.value.reason == "signature_mismatch"

"""Small wire helpers shared by SDK transport tests."""

from __future__ import annotations

from typing import Any


def v1(data: Any) -> dict[str, Any]:
    """Wrap response data in the stable Janusly success envelope."""
    return {"apiVersion": "v1", "requestId": "sdk-test", "data": data}

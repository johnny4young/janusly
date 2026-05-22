"""Smoke tests on the package metadata + import surface."""

from __future__ import annotations

from importlib import import_module
from pathlib import Path


def test_py_typed_marker_present() -> None:
    """PEP 561 marker must ship alongside source so type checkers recognize the package."""
    src_root = Path(__file__).resolve().parent.parent / "src" / "janusly"
    assert (src_root / "py.typed").is_file()


def test_pyproject_pins_python_3_10_minimum() -> None:
    """The catalog promises Python 3.10+ — guard against a v2 bump regressing the floor."""
    pyproject = Path(__file__).resolve().parent.parent / "pyproject.toml"
    assert pyproject.is_file()
    content = pyproject.read_text(encoding="utf-8")
    assert 'requires-python = ">=3.10"' in content


def test_webhooks_module_imports_without_httpx() -> None:
    """The janusly.webhooks helper must NOT trigger any httpx import.

    Lambda receivers that pip-install janusly and only use the verifier
    rely on this — httpx pulls in anyio + sniffio + idna + h11 etc., and
    those should not load when verify_signature is the only consumed
    surface. Confirmed by importing the module fresh and asserting
    httpx is absent from sys.modules unless the caller already loaded it.

    (We don't try to make the FULL package import skip httpx — `import janusly`
    does pull the client. The lightweight contract is on `from janusly.webhooks import …`.)
    """
    import sys

    # Save + clear any pre-imported httpx so the test reflects a clean slate.
    saved_httpx = sys.modules.pop("httpx", None)
    saved_webhooks = sys.modules.pop("janusly.webhooks", None)
    try:
        webhooks_module = import_module("janusly.webhooks")
        assert hasattr(webhooks_module, "verify_signature")
        # Confirm the webhook helper module itself didn't trigger an httpx
        # import as a side effect.
        assert "httpx" not in sys.modules
    finally:
        # Restore prior state to keep other tests isolated.
        if saved_httpx is not None:
            sys.modules["httpx"] = saved_httpx
        if saved_webhooks is not None:
            sys.modules["janusly.webhooks"] = saved_webhooks

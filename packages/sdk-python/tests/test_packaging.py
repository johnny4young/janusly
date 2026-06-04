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

    Full-package `import janusly` is lazy too, but this submodule path is
    the strictest contract: webhook-only consumers must be able to import the
    verifier without importing the client transport at all.
    """
    import sys

    # Save + clear any pre-imported modules so the test reflects a clean
    # process. Importing a submodule executes `janusly.__init__` first, so the
    # package itself must be cleared too — otherwise this would miss eager
    # client imports in `__init__`.
    saved_package = sys.modules.pop("janusly", None)
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
        if saved_package is not None:
            sys.modules["janusly"] = saved_package


def test_top_level_client_reexports_are_lazy_but_available() -> None:
    """`from janusly import JanuslyClient` remains the public convenience path."""
    import sys

    # Accessing the lazy client symbols imports `.client` / `.async_client` /
    # `._http` (and httpx) into sys.modules. Save + restore those submodules
    # too, so this test leaves sys.modules exactly as it found it — matching
    # the isolation discipline of `test_webhooks_module_imports_without_httpx`
    # and preventing inter-test contamination.
    managed = ("janusly", "janusly.client", "janusly.async_client", "janusly._http", "httpx")
    saved = {name: sys.modules.pop(name, None) for name in managed}
    try:
        import janusly

        assert "JanuslyClient" not in janusly.__dict__
        assert "httpx" not in sys.modules
        client_cls = janusly.JanuslyClient
        async_client_cls = janusly.JanuslyAsyncClient
        retry_config_cls = janusly.RetryConfig
        assert client_cls.__name__ == "JanuslyClient"
        assert async_client_cls.__name__ == "JanuslyAsyncClient"
        assert retry_config_cls.__name__ == "RetryConfig"
        # The lazy lookup caches the resolved symbols so repeated access is
        # normal attribute access.
        assert janusly.__dict__["JanuslyClient"] is client_cls
        assert janusly.__dict__["JanuslyAsyncClient"] is async_client_cls
        assert janusly.__dict__["RetryConfig"] is retry_config_cls
    finally:
        for name, module in saved.items():
            if module is not None:
                sys.modules[name] = module
            else:
                sys.modules.pop(name, None)

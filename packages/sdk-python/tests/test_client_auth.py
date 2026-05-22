"""Tests for the HTTP client's header composition + base-URL normalization."""

from __future__ import annotations

import pytest

from janusly import BearerAuth, ServiceTokenAuth
from janusly._http import build_headers, make_config


def test_service_token_sends_authorization_and_user_id() -> None:
    config = make_config(
        base_url="https://api.test/",
        org_id="acme",
        auth=ServiceTokenAuth(token="svc-token", user_id="ops-bot"),
    )
    headers = build_headers(config)
    assert headers["Authorization"] == "Bearer svc-token"
    assert headers["x-user-id"] == "ops-bot"
    assert headers["x-org-id"] == "acme"
    assert headers["Accept"] == "application/json"


def test_bearer_auth_omits_user_id() -> None:
    config = make_config(
        base_url="https://api.test",
        org_id="acme",
        auth=BearerAuth(token="jwt-token"),
    )
    headers = build_headers(config)
    assert headers["Authorization"] == "Bearer jwt-token"
    assert "x-user-id" not in headers


def test_base_url_trailing_slash_is_stripped() -> None:
    config = make_config(
        base_url="https://api.test///",
        org_id="acme",
        auth=BearerAuth(token="t"),
    )
    assert config.base_url == "https://api.test"


def test_user_agent_suffix_concatenates() -> None:
    config = make_config(
        base_url="https://api.test",
        org_id="acme",
        auth=BearerAuth(token="t"),
        user_agent_suffix="acme-pipeline/1.0",
    )
    assert "acme-pipeline/1.0" in config.user_agent
    assert config.user_agent.startswith("janusly-python/")


def test_header_injection_guard_rejects_reserved_names() -> None:
    config = make_config(
        base_url="https://api.test",
        org_id="acme",
        auth=BearerAuth(token="t"),
    )
    with pytest.raises(ValueError, match="reserved header"):
        build_headers(config, extra={"x-org-id": "other-org"})
    with pytest.raises(ValueError, match="reserved header"):
        build_headers(config, extra={"Authorization": "Bearer evil"})


def test_user_supplied_extras_pass_through() -> None:
    config = make_config(
        base_url="https://api.test",
        org_id="acme",
        auth=BearerAuth(token="t"),
    )
    headers = build_headers(config, extra={"X-Custom": "ok"})
    assert headers["X-Custom"] == "ok"

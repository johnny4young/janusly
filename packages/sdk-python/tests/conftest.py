"""Shared pytest fixtures for the Janusly SDK tests."""

from __future__ import annotations

import pytest

from janusly._http import ClientConfig, ServiceTokenAuth, make_config


@pytest.fixture
def base_config() -> ClientConfig:
    """A standard ClientConfig for the request-layer tests."""
    return make_config(
        base_url="https://api.test.janus.ly",
        org_id="test-org",
        auth=ServiceTokenAuth(token="test-token", user_id="test-user"),
    )

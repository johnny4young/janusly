"""Tests for the reports resource (markdown + json exports)."""

from __future__ import annotations

import pytest
from pytest_httpx import HTTPXMock

from janusly import JanuslyClient, ServiceTokenAuth


@pytest.fixture
def client() -> JanuslyClient:
    return JanuslyClient(
        base_url="https://api.test.janus.ly",
        org_id="test-org",
        auth=ServiceTokenAuth(token="test-token", user_id="test-user"),
    )


def test_export_run_explain_markdown_parses_filename(
    client: JanuslyClient,
    httpx_mock: HTTPXMock,
) -> None:
    httpx_mock.add_response(
        url="https://api.test.janus.ly/reports/run-explain?runId=r-1&format=markdown",
        content=b"# Report",
        headers={
            "content-type": "text/markdown; charset=utf-8",
            "content-disposition": 'attachment; filename="janusly-billing-failed-2026-05-21.md"',
        },
    )
    result = client.reports.export_run_explain("r-1", format="markdown")
    assert result["body"] == b"# Report"
    assert result["content_type"].startswith("text/markdown")
    assert result["filename"] == "janusly-billing-failed-2026-05-21.md"


def test_export_run_explain_json(client: JanuslyClient, httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url="https://api.test.janus.ly/reports/run-explain?runId=r-2&format=json",
        content=b'{"run":{"id":"r-2"}}',
        headers={
            "content-type": "application/json",
            "content-disposition": 'attachment; filename="janusly-r-2.json"',
        },
    )
    result = client.reports.export_run_explain("r-2", format="json")
    assert result["body"] == b'{"run":{"id":"r-2"}}'
    assert result["filename"] == "janusly-r-2.json"

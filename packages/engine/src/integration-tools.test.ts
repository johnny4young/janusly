/**
 * Tests for the three integration tools (`slack.post`,
 * `github.create_issue`, `webhook.send`) plus the `signWebhookPayload`
 * helper. Mocks the credentials repo + `fetchHttpTarget` + the DI seams
 * (rate-limit + integration-usage recorder) so the tools' wrapper logic
 * (credential lookup, env resolution, rate gate, recorder fire, output
 * envelope) can be exercised without a real network call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@janusly/data/src/credentialsRepo", () => ({
  getCredentialByName: vi.fn(),
}));

vi.mock("./http-policy", () => ({
  fetchHttpTarget: vi.fn(),
}));

import { getCredentialByName, type Credential } from "@janusly/data/src/credentialsRepo";
import { fetchHttpTarget } from "./http-policy";
import {
  _resetIntegrationUsageRecorderForTests,
  setIntegrationUsageRecorder,
  type IntegrationUsageRecord,
} from "./integration-usage";
import {
  _resetEngineRateLimiterForTests,
  setEngineRateLimiter,
} from "./rate-limit";
import { signWebhookPayload } from "./integration-tools";
import { executeTool, isToolWriteSide } from "./tool-registry";

const credentialMock = vi.mocked(getCredentialByName);
const fetchMock = vi.mocked(fetchHttpTarget);
const captured: IntegrationUsageRecord[] = [];

function credentialRow(overrides: Partial<Credential> = {}): Credential {
  return {
    id: "cred-1",
    orgId: "org-1",
    name: "default-cred",
    kind: "slack_webhook",
    secretRef: "INCIDENTS_SLACK_WEBHOOK_URL",
    metadata: null,
    createdBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  captured.length = 0;
  credentialMock.mockReset();
  fetchMock.mockReset();
  _resetEngineRateLimiterForTests();
  _resetIntegrationUsageRecorderForTests();
  setIntegrationUsageRecorder((record) => { captured.push(record); });
});

afterEach(() => {
  _resetEngineRateLimiterForTests();
  _resetIntegrationUsageRecorderForTests();
  vi.unstubAllEnvs();
});

describe("integration tools — registry registration", () => {
  it("all three are write-side", () => {
    expect(isToolWriteSide("slack.post")).toBe(true);
    expect(isToolWriteSide("github.create_issue")).toBe(true);
    expect(isToolWriteSide("webhook.send")).toBe(true);
  });
});

describe("signWebhookPayload", () => {
  it("produces a deterministic Stripe-style signature", () => {
    const sig1 = signWebhookPayload("shared-secret", '{"event":"x"}', 1_700_000_000);
    const sig2 = signWebhookPayload("shared-secret", '{"event":"x"}', 1_700_000_000);
    expect(sig1).toBe(sig2);
    expect(sig1).toMatch(/^t=1700000000,v1=[a-f0-9]{64}$/);
  });

  it("changes when the body, timestamp, or secret changes", () => {
    const base = signWebhookPayload("shared-secret", '{"a":1}', 1_700_000_000);
    expect(signWebhookPayload("shared-secret", '{"a":2}', 1_700_000_000)).not.toBe(base);
    expect(signWebhookPayload("shared-secret", '{"a":1}', 1_700_000_001)).not.toBe(base);
    expect(signWebhookPayload("other-secret", '{"a":1}', 1_700_000_000)).not.toBe(base);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// slack.post
// ──────────────────────────────────────────────────────────────────────────

describe("slack.post", () => {
  it("posts to the credential's webhook URL and returns ok:true on 200", async () => {
    vi.stubEnv("INCIDENTS_SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/T00/B00/abc");
    credentialMock.mockResolvedValueOnce(credentialRow({ name: "incidents-slack", kind: "slack_webhook" }));
    fetchMock.mockResolvedValueOnce({ statusCode: 200, ok: true, body: "ok", headers: {} });

    const result = await executeTool(
      "slack.post",
      { credential: "incidents-slack", text: "Hello" },
      {},
      { orgId: "org-1", runId: "r1", nodeId: "n1", workflowId: "wf-1" },
    );

    expect(result).toMatchObject({ ok: true, statusCode: 200 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://hooks.slack.com/services/T00/B00/abc",
      expect.objectContaining({ method: "POST" }),
    );
    const fetchInit = fetchMock.mock.calls[0][1] as { body?: string };
    expect(JSON.parse(fetchInit.body!)).toEqual({ text: "Hello" });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      orgId: "org-1",
      tool: "slack.post",
      credentialName: "incidents-slack",
      ok: true,
      statusCode: 200,
    });
  });

  it("returns ok:false when the credential row is missing (without leaking env-var name)", async () => {
    credentialMock.mockResolvedValueOnce(null);

    const result = await executeTool(
      "slack.post",
      { credential: "ghost", text: "Hello" },
      {},
      { orgId: "org-1" },
    );

    expect((result as { ok: boolean }).ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/credential not found: ghost/);
    expect((result as { error: string }).error).not.toMatch(/SLACK|ENV|secret_ref|INCIDENTS/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(captured[0]).toMatchObject({ ok: false });
  });

  it("returns ok:false when the secret-ref env is unset (env var name NOT in the error)", async () => {
    // Env intentionally not set for INCIDENTS_SLACK_WEBHOOK_URL.
    vi.stubEnv("INCIDENTS_SLACK_WEBHOOK_URL", "");
    credentialMock.mockResolvedValueOnce(credentialRow({ name: "incidents-slack", kind: "slack_webhook" }));

    const result = await executeTool(
      "slack.post",
      { credential: "incidents-slack", text: "Hello" },
      {},
      { orgId: "org-1" },
    );

    expect((result as { ok: boolean }).ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/credential secret missing/);
    expect((result as { error: string }).error).not.toContain("INCIDENTS_SLACK_WEBHOOK_URL");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a credential URL that doesn't point at hooks.slack.com (defense in depth)", async () => {
    vi.stubEnv("INCIDENTS_SLACK_WEBHOOK_URL", "https://evil.example.com/hooks/abc");
    credentialMock.mockResolvedValueOnce(credentialRow({ name: "incidents-slack", kind: "slack_webhook" }));

    const result = await executeTool(
      "slack.post",
      { credential: "incidents-slack", text: "Hi" },
      {},
      { orgId: "org-1" },
    );

    expect((result as { ok: boolean }).ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/hooks.slack.com/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts the explicitly enabled local Slack simulator", async () => {
    vi.stubEnv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true");
    vi.stubEnv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR_URL", "http://provider-simulator:4010");
    vi.stubEnv("INCIDENTS_SLACK_WEBHOOK_URL", "http://provider-simulator:4010/slack/services/local/ops");
    credentialMock.mockResolvedValueOnce(credentialRow({ name: "incidents-slack" }));
    fetchMock.mockResolvedValueOnce({ statusCode: 200, ok: true, body: "ok", headers: {} });

    const result = await executeTool(
      "slack.post",
      { credential: "incidents-slack", text: "Local page" },
      {},
      { orgId: "org-1" },
    );

    expect(result).toMatchObject({ ok: true, statusCode: 200 });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://provider-simulator:4010/slack/services/local/ops",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("maps a non-2xx response to ok:false with statusCode + error", async () => {
    vi.stubEnv("INCIDENTS_SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/T00/B00/abc");
    credentialMock.mockResolvedValueOnce(credentialRow({ name: "incidents-slack" }));
    fetchMock.mockResolvedValueOnce({ statusCode: 400, ok: false, body: "invalid_payload", headers: {} });

    const result = await executeTool(
      "slack.post",
      { credential: "incidents-slack", text: "Hi" },
      {},
      { orgId: "org-1" },
    );

    expect((result as { ok: boolean }).ok).toBe(false);
    expect((result as { statusCode?: number }).statusCode).toBe(400);
    expect((result as { error: string }).error).toMatch(/400/);
    expect(captured[0]).toMatchObject({ ok: false, statusCode: 400 });
  });

  it("scrubs the webhook URL from fetchHttpTarget rejection errors (path encodes the secret token)", async () => {
    const secretUrl = "https://hooks.slack.com/services/T00/B00/REDACTED_SECRET_TOKEN_xyz";
    vi.stubEnv("INCIDENTS_SLACK_WEBHOOK_URL", secretUrl);
    credentialMock.mockResolvedValueOnce(credentialRow({ name: "incidents-slack" }));
    // Simulate the redirect-limit error shape that embeds the original URL —
    // exactly the leak path the reviewer flagged.
    fetchMock.mockRejectedValueOnce(new Error(`HTTP redirect limit exceeded; last hop ${secretUrl} -> ${secretUrl}/2`));

    const result = await executeTool(
      "slack.post",
      { credential: "incidents-slack", text: "Hi" },
      {},
      { orgId: "org-1" },
    );

    expect((result as { ok: boolean }).ok).toBe(false);
    const error = (result as { error: string }).error;
    expect(error).not.toContain("REDACTED_SECRET_TOKEN_xyz");
    expect(error).not.toContain("hooks.slack.com");
    expect(error).toBe("network error calling slack webhook");
    // The usage event must also stay scrubbed — operators read this in
    // the billing dashboard.
    expect(captured[0]).toMatchObject({ ok: false, error: "network error calling slack webhook" });
  });

  it("hits the rate limit → ok:false, fetch not called, usage row still written", async () => {
    vi.stubEnv("INCIDENTS_SLACK_WEBHOOK_URL", "https://hooks.slack.com/services/T00/B00/abc");
    credentialMock.mockResolvedValueOnce(credentialRow({ name: "incidents-slack" }));
    setEngineRateLimiter(async () => { throw new Error("Rate limit exceeded"); });

    const result = await executeTool(
      "slack.post",
      { credential: "incidents-slack", text: "Hi" },
      {},
      { orgId: "org-1" },
    );

    expect((result as { ok: boolean }).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(captured[0]).toMatchObject({ ok: false, error: "Rate limit exceeded" });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// github.create_issue
// ──────────────────────────────────────────────────────────────────────────

describe("github.create_issue", () => {
  it("routes to the explicitly enabled local GitHub simulator", async () => {
    vi.stubEnv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true");
    vi.stubEnv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR_URL", "http://provider-simulator:4010");
    vi.stubEnv("GITHUB_BOT_TOKEN", "local-token");
    credentialMock.mockResolvedValueOnce(credentialRow({
      name: "bot-github",
      kind: "github_token",
      secretRef: "GITHUB_BOT_TOKEN",
    }));
    fetchMock.mockResolvedValueOnce({
      statusCode: 201,
      ok: true,
      body: '{"number":42,"html_url":"http://provider-simulator:4010/ui/issues/42"}',
      headers: {},
    });

    const result = await executeTool(
      "github.create_issue",
      { credential: "bot-github", owner: "acme", repo: "incidents", title: "Local incident" },
      {},
      { orgId: "org-1" },
    );

    expect(result).toMatchObject({ ok: true, issueNumber: 42 });
    expect(fetchMock.mock.calls[0]?.[0])
      .toBe("http://provider-simulator:4010/github/repos/acme/incidents/issues");
  });

  it("creates an issue and surfaces issueNumber + url on 201", async () => {
    vi.stubEnv("GITHUB_BOT_TOKEN", "ghp_redacted");
    credentialMock.mockResolvedValueOnce(credentialRow({
      name: "bot-github", kind: "github_token", secretRef: "GITHUB_BOT_TOKEN",
    }));
    fetchMock.mockResolvedValueOnce({
      statusCode: 201,
      ok: true,
      body: JSON.stringify({ number: 42, html_url: "https://github.com/janusly/demo/issues/42" }),
      headers: {},
    });

    const result = await executeTool(
      "github.create_issue",
      { credential: "bot-github", owner: "janusly", repo: "demo", title: "Bug", body: "Details" },
      {},
      { orgId: "org-1", runId: "r1", nodeId: "n1" },
    );

    expect(result).toMatchObject({
      ok: true,
      issueNumber: 42,
      url: "https://github.com/janusly/demo/issues/42",
      statusCode: 201,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/janusly/demo/issues",
      expect.objectContaining({ method: "POST" }),
    );
    const fetchInit = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(fetchInit.headers["authorization"]).toBe("Bearer ghp_redacted");
  });

  it("URL-encodes owner and repo (no path injection)", async () => {
    vi.stubEnv("GITHUB_BOT_TOKEN", "ghp_redacted");
    credentialMock.mockResolvedValueOnce(credentialRow({ name: "bot-github", kind: "github_token", secretRef: "GITHUB_BOT_TOKEN" }));
    fetchMock.mockResolvedValueOnce({
      statusCode: 201,
      ok: true,
      body: JSON.stringify({ number: 1, html_url: "x" }),
      headers: {},
    });

    await executeTool(
      "github.create_issue",
      { credential: "bot-github", owner: "weird/owner", repo: "weird repo", title: "x" },
      {},
      { orgId: "org-1" },
    );

    const url = fetchMock.mock.calls[0][0];
    expect(url).toBe("https://api.github.com/repos/weird%2Fowner/weird%20repo/issues");
  });

  it("maps a 422 to ok:false with the GitHub message — but never the token", async () => {
    vi.stubEnv("GITHUB_BOT_TOKEN", "ghp_redacted-1234");
    credentialMock.mockResolvedValueOnce(credentialRow({ name: "bot-github", kind: "github_token", secretRef: "GITHUB_BOT_TOKEN" }));
    fetchMock.mockResolvedValueOnce({
      statusCode: 422,
      ok: false,
      body: JSON.stringify({ message: "Validation Failed", errors: [] }),
      headers: {},
    });

    const result = await executeTool(
      "github.create_issue",
      { credential: "bot-github", owner: "x", repo: "y", title: "z" },
      {},
      { orgId: "org-1" },
    );

    expect((result as { ok: boolean }).ok).toBe(false);
    expect((result as { error: string }).error).toBe("Validation Failed");
    expect((result as { error: string }).error).not.toMatch(/ghp_/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// webhook.send
// ──────────────────────────────────────────────────────────────────────────

describe("webhook.send", () => {
  it("rewrites reserved example.com placeholders only in explicit local simulator mode", async () => {
    vi.stubEnv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true");
    vi.stubEnv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR_URL", "http://provider-simulator:4010");
    vi.stubEnv("PARTNER_WEBHOOK_SECRET", "local-secret");
    credentialMock.mockResolvedValueOnce(credentialRow({
      name: "partner-webhook",
      kind: "webhook_secret",
      secretRef: "PARTNER_WEBHOOK_SECRET",
    }));
    fetchMock.mockResolvedValueOnce({ statusCode: 202, ok: true, body: "accepted", headers: {} });

    const result = await executeTool(
      "webhook.send",
      { credential: "partner-webhook", url: "https://billing.example.com/charges/retry", payload: { invoiceId: "inv-1" } },
      {},
      { orgId: "org-1" },
    );

    expect(result).toMatchObject({ ok: true, statusCode: 202 });
    expect(fetchMock.mock.calls[0]?.[0])
      .toBe("http://provider-simulator:4010/webhook?target=https%3A%2F%2Fbilling.example.com%2Fcharges%2Fretry");
  });

  it("signs the body and sends it via fetchHttpTarget with the default header", async () => {
    vi.stubEnv("WEBHOOK_SIGNING_SECRET", "supers3cret");
    credentialMock.mockResolvedValueOnce(credentialRow({
      name: "partner-webhook", kind: "webhook_secret", secretRef: "WEBHOOK_SIGNING_SECRET",
    }));
    fetchMock.mockResolvedValueOnce({ statusCode: 200, ok: true, body: "{}", headers: {} });

    const result = await executeTool(
      "webhook.send",
      {
        credential: "partner-webhook",
        url: "https://partner.example.com/hooks/incident",
        payload: { event: "incident", severity: "high" },
      },
      {},
      { orgId: "org-1" },
    );

    expect((result as { ok: boolean }).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls[0];
    const signature = (init as { headers: Record<string, string> }).headers["x-janusly-signature"];
    expect(signature).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);

    // Body is what we signed — verify we can reproduce the signature with the same secret.
    const bodyAttr = (init as { body?: string }).body!;
    const t = Number(signature.match(/t=(\d+)/)![1]);
    const expected = signWebhookPayload("supers3cret", bodyAttr, t);
    expect(signature).toBe(expected);
  });

  it("uses the operator-supplied signatureHeader override", async () => {
    vi.stubEnv("WEBHOOK_SIGNING_SECRET", "supers3cret");
    credentialMock.mockResolvedValueOnce(credentialRow({
      name: "partner-webhook", kind: "webhook_secret", secretRef: "WEBHOOK_SIGNING_SECRET",
    }));
    fetchMock.mockResolvedValueOnce({ statusCode: 200, ok: true, body: "{}", headers: {} });

    await executeTool(
      "webhook.send",
      {
        credential: "partner-webhook",
        url: "https://partner.example.com/hooks",
        payload: { x: 1 },
        signatureHeader: "X-Custom-Signature",
      },
      {},
      { orgId: "org-1" },
    );

    const [, init] = fetchMock.mock.calls[0];
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers["x-custom-signature"]).toBeTruthy();
    expect(headers["x-janusly-signature"]).toBeUndefined();
  });

  it("ignores reserved custom headers while keeping safe idempotency headers", async () => {
    vi.stubEnv("WEBHOOK_SIGNING_SECRET", "supers3cret");
    credentialMock.mockResolvedValueOnce(credentialRow({
      name: "partner-webhook", kind: "webhook_secret", secretRef: "WEBHOOK_SIGNING_SECRET",
    }));
    fetchMock.mockResolvedValueOnce({ statusCode: 200, ok: true, body: "{}", headers: {} });

    await executeTool(
      "webhook.send",
      {
        credential: "partner-webhook",
        url: "https://partner.example.com/hooks",
        payload: { x: 1 },
        headers: {
          Authorization: "Bearer should-not-send",
          "X-Janusly-Signature": "fake-signature",
          "X-Idempotency-Key": "recovery_item_1",
        },
      },
      {},
      { orgId: "org-1" },
    );

    const [, init] = fetchMock.mock.calls[0];
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers.authorization).toBeUndefined();
    expect(headers["x-janusly-signature"]).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);
    expect(headers["x-idempotency-key"]).toBe("recovery_item_1");
  });

  it("maps fetchHttpTarget rejection (SSRF / DNS) to a clean envelope", async () => {
    vi.stubEnv("WEBHOOK_SIGNING_SECRET", "supers3cret");
    credentialMock.mockResolvedValueOnce(credentialRow({
      name: "partner-webhook", kind: "webhook_secret", secretRef: "WEBHOOK_SIGNING_SECRET",
    }));
    fetchMock.mockRejectedValueOnce(new Error("Refusing to connect to private host"));

    const result = await executeTool(
      "webhook.send",
      {
        credential: "partner-webhook",
        url: "https://localhost/hooks",
        payload: { x: 1 },
      },
      {},
      { orgId: "org-1" },
    );

    expect((result as { ok: boolean }).ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/private host/);
    expect(captured[0]).toMatchObject({ ok: false, error: expect.stringMatching(/private host/) });
  });
});

/** Static safety classification for shared registered-tool dispatch. */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dryRunToolSkipPayload,
  isProviderSimulationToolInvocation,
  isToolInvocationWriteSide,
} from "./tool-execution";

afterEach(() => vi.unstubAllEnvs());

describe("isToolInvocationWriteSide", () => {
  it("distinguishes explicit read and write HTTP methods", () => {
    expect(isToolInvocationWriteSide("http.request", { url: "https://example.com" })).toBe(false);
    expect(isToolInvocationWriteSide("http.request", { url: "https://example.com", method: "GET" })).toBe(false);
    expect(isToolInvocationWriteSide("http.request", { url: "https://example.com", method: "POST" })).toBe(true);
  });

  it("fails safe for whole-object and malformed dynamic HTTP inputs", () => {
    expect(isToolInvocationWriteSide("http.request", "{{item}}")).toBe(true);
    expect(isToolInvocationWriteSide("http.request", { method: "{{item.method}}" })).toBe(true);
    expect(isToolInvocationWriteSide("http.request", { method: 1 })).toBe(true);
  });

  it("uses the registry flag for non-HTTP tools", () => {
    expect(isToolInvocationWriteSide("email.send", {})).toBe(true);
    expect(isToolInvocationWriteSide("json.parse", {})).toBe(false);
  });
});

describe("provider-simulated tool execution", () => {
  const input = {
    credential: "billing_webhook",
    url: "https://billing.example.com/charges/retry",
    payload: { invoiceId: "invoice-1" },
    headers: { "X-Idempotency-Key": "invoice-1" },
  };

  it("permits only a fully gated idempotent local webhook", () => {
    vi.stubEnv("JANUSLY_LOCAL_STACK", "true");
    vi.stubEnv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true");
    vi.stubEnv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR_URL", "http://provider-simulator:4010");

    expect(isProviderSimulationToolInvocation("webhook.send", input)).toBe(true);
    expect(dryRunToolSkipPayload("webhook.send", input, "provider_simulation")).toBeNull();
    expect(dryRunToolSkipPayload("webhook.send", input, "skip")).toMatchObject({
      reason: expect.stringContaining("skipped"),
    });
  });

  it("fails closed when any process gate or idempotency key is missing", () => {
    vi.stubEnv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true");
    vi.stubEnv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR_URL", "http://provider-simulator:4010");
    expect(isProviderSimulationToolInvocation("webhook.send", input)).toBe(false);

    vi.stubEnv("JANUSLY_LOCAL_STACK", "true");
    expect(isProviderSimulationToolInvocation("webhook.send", {
      ...input,
      headers: {},
    })).toBe(false);
    expect(isProviderSimulationToolInvocation("webhook.send", {
      ...input,
      url: "http://provider-simulator:4010/webhook?target=https://billing.example.com/retry",
    })).toBe(false);
  });
});

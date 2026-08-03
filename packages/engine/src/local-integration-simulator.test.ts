import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getLocalIntegrationSimulatorUrl,
  isLocalIntegrationSimulatorEndpoint,
  isLocalSlackSimulatorUrl,
  isLocalWebhookPlaceholder,
  localIntegrationSimulatorEndpoint,
  parseProviderSimulationReceipt,
  resolveLocalWebhookDestination,
} from "./local-integration-simulator";

afterEach(() => vi.unstubAllEnvs());

function enable(url = "http://provider-simulator:4010/base/"): void {
  vi.stubEnv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true");
  vi.stubEnv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR_URL", url);
}

describe("local integration simulator routing", () => {
  it("is disabled by default", () => {
    expect(getLocalIntegrationSimulatorUrl()).toBeNull();
    expect(localIntegrationSimulatorEndpoint("/github")).toBeNull();
    expect(resolveLocalWebhookDestination("https://billing.example.com/retry"))
      .toBe("https://billing.example.com/retry");
  });

  it("rejects unsafe or ambiguous base URLs", () => {
    enable("file:///tmp/simulator");
    expect(() => getLocalIntegrationSimulatorUrl()).toThrow(/http or https/);
    enable("http://user:secret@provider-simulator:4010/?mode=ok");
    expect(() => getLocalIntegrationSimulatorUrl()).toThrow(/credentials, a query, or a fragment/);
  });

  it("builds provider endpoints and accepts only its Slack subtree", () => {
    enable();
    expect(localIntegrationSimulatorEndpoint("github/repos/acme/demo/issues"))
      .toBe("http://provider-simulator:4010/base/github/repos/acme/demo/issues");
    expect(isLocalSlackSimulatorUrl("http://provider-simulator:4010/base/slack/services/local/demo"))
      .toBe(true);
    expect(isLocalSlackSimulatorUrl("http://provider-simulator:4010/base/github/issues"))
      .toBe(false);
  });

  it("rewrites only reserved example.com webhook placeholders", () => {
    enable("http://provider-simulator:4010");
    const destination = resolveLocalWebhookDestination("https://billing.example.com/charges/retry");
    expect(destination)
      .toBe("http://provider-simulator:4010/webhook?target=https%3A%2F%2Fbilling.example.com%2Fcharges%2Fretry");
    expect(isLocalIntegrationSimulatorEndpoint(destination, "/webhook")).toBe(true);
    expect(isLocalIntegrationSimulatorEndpoint("http://provider-simulator:4010/webhook-evil", "/webhook")).toBe(false);
    expect(isLocalWebhookPlaceholder("https://billing.example.com/charges/retry")).toBe(true);
    expect(isLocalWebhookPlaceholder("https://user:secret@billing.example.com/charges/retry")).toBe(false);
    expect(resolveLocalWebhookDestination("https://api.example.org/real"))
      .toBe("https://api.example.org/real");
  });

  it("accepts only complete internally consistent provider receipts", () => {
    const receipt = {
      kind: "provider_simulation_receipt",
      version: 1,
      provider: "webhook",
      operation: "deliver",
      scope: "validation",
      effectId: "effect-1",
      idempotencyKey: "invoice-1",
      applied: true,
      duplicate: false,
      requestId: "request-1",
    };
    expect(parseProviderSimulationReceipt(receipt, "validation")).toEqual(receipt);
    expect(parseProviderSimulationReceipt({ ...receipt, scope: "production" }, "validation")).toBeNull();
    expect(parseProviderSimulationReceipt({ ...receipt, duplicate: true }, "validation")).toBeNull();
    expect(parseProviderSimulationReceipt({ ...receipt, effectId: "" }, "validation")).toBeNull();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { qualifyProviderSimulationWorkflow } from "./provider-simulation-validation";

afterEach(() => vi.unstubAllEnvs());

function enableLocalSimulation(): void {
  vi.stubEnv("JANUSLY_LOCAL_STACK", "true");
  vi.stubEnv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR", "true");
  vi.stubEnv("JANUSLY_LOCAL_INTEGRATION_SIMULATOR_URL", "http://provider-simulator:4010");
}

function workflow(nodes: Array<{ id: string; type: string; config: Record<string, unknown> }>) {
  return {
    dslVersion: "1.0",
    id: "workflow-1",
    name: "Recovery qualification",
    nodes,
    edges: nodes.slice(1).map((node, index) => ({
      from: nodes[index]!.id,
      to: node.id,
    })),
  } as never;
}

describe("qualifyProviderSimulationWorkflow", () => {
  it("accepts a direct idempotent reserved webhook on the validation path", () => {
    enableLocalSimulation();
    const result = qualifyProviderSimulationWorkflow(workflow([
      { id: "approval", type: "approval", config: {} },
      {
        id: "retry-charge",
        type: "tool",
        config: {
          tool: "webhook.send",
          resultPolicy: "require_ok",
          input: {
            credential: "billing_webhook",
            url: "https://billing.example.com/charges/retry",
            payload: { invoiceId: "invoice-1" },
            headers: { "X-Idempotency-Key": "invoice-1" },
          },
        },
      },
      { id: "done", type: "noop", config: {} },
    ]), "retry-charge");

    expect(result).toEqual({ ok: true, effectNodeIds: ["retry-charge"] });
  });

  it("rejects the same workflow when process-level local gates are absent", () => {
    const result = qualifyProviderSimulationWorkflow(workflow([{
      id: "retry-charge",
      type: "tool",
      config: {
        tool: "webhook.send",
        resultPolicy: "require_ok",
        input: {
          credential: "billing_webhook",
          url: "https://billing.example.com/charges/retry",
          payload: {},
          headers: { "X-Idempotency-Key": "invoice-1" },
        },
      },
    }]), "retry-charge");

    expect(result).toMatchObject({ ok: false, nodeId: "retry-charge" });
  });

  it.each([
    {
      name: "non-reserved destination",
      node: {
        id: "write",
        type: "tool",
        config: {
          tool: "webhook.send",
          resultPolicy: "require_ok",
          input: {
            credential: "billing_webhook",
            url: "https://billing.example.org/charges/retry",
            payload: {},
            headers: { "X-Idempotency-Key": "invoice-1" },
          },
        },
      },
    },
    {
      name: "missing idempotency key",
      node: {
        id: "write",
        type: "tool",
        config: {
          tool: "webhook.send",
          resultPolicy: "require_ok",
          input: {
            credential: "billing_webhook",
            url: "https://billing.example.com/charges/retry",
            payload: {},
          },
        },
      },
    },
    {
      name: "non-enforcing result policy",
      node: {
        id: "write",
        type: "tool",
        config: {
          tool: "webhook.send",
          input: {
            credential: "billing_webhook",
            url: "https://billing.example.com/charges/retry",
            payload: {},
            headers: { "X-Idempotency-Key": "invoice-1" },
          },
        },
      },
    },
    {
      name: "dynamic planner",
      node: { id: "write", type: "agent", config: { prompt: "Send a webhook" } },
    },
  ])("rejects $name", ({ node }) => {
    enableLocalSimulation();
    expect(qualifyProviderSimulationWorkflow(workflow([node]), "write"))
      .toMatchObject({ ok: false, nodeId: "write" });
  });

  it("ignores effects outside the descendant validation path", () => {
    enableLocalSimulation();
    const candidate = {
      dslVersion: "1.0",
      id: "workflow-1",
      name: "Branch qualification",
      nodes: [
        { id: "write", type: "tool", config: {
          tool: "webhook.send",
          resultPolicy: "require_ok",
          input: {
            credential: "billing_webhook",
            url: "https://billing.example.com/charges/retry",
            payload: {},
            headers: { "X-Idempotency-Key": "invoice-1" },
          },
        } },
        { id: "done", type: "noop", config: {} },
        { id: "unrelated-agent", type: "agent", config: { prompt: "Write elsewhere" } },
      ],
      edges: [{ from: "write", to: "done" }],
    } as never;

    expect(qualifyProviderSimulationWorkflow(candidate, "write"))
      .toEqual({ ok: true, effectNodeIds: ["write"] });
  });
});

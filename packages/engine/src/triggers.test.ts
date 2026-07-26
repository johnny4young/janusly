/**
 * Tests for the event-driven trigger node executors + config resolution.
 *
 * Trigger nodes are passthrough triggers (like `schedule`): the executor
 * validates the authored config and succeeds with `{ triggeredBy, event }`,
 * reading the normalized inbound event the ingestion seam stuffed into the
 * run input. The actual SMTP relay / bucket-event listener / MCP subscriber
 * lives in the API ingestion seam, NOT here — so these tests assert the
 * executor never reaches out and faithfully passes the event through.
 */

import { describe, expect, it } from "vitest";
import {
  emailReceivedExecutor,
  fileDroppedExecutor,
  mcpServerEventExecutor,
  pagerDutyIncidentExecutor,
  webhookReceivedExecutor,
  resolveTriggerConfig,
} from "./triggers";
import type { NodeContext } from "./node-registry";

function ctx(config: Record<string, unknown>, context: Record<string, unknown> = {}): NodeContext {
  return { runId: "r1", nodeId: "trigger", orgId: "org-a", workflowId: "w1", config, context };
}

describe("resolveTriggerConfig", () => {
  it("validates a webhook_received config", () => {
    expect(() => resolveTriggerConfig("webhook_received", { endpointKey: "incident-triage" })).not.toThrow();
    expect(() => resolveTriggerConfig("webhook_received", {})).toThrow();
  });

  it("validates an email_received config", () => {
    expect(() => resolveTriggerConfig("email_received", { aliasKey: "ops" })).not.toThrow();
    expect(() => resolveTriggerConfig("email_received", {})).toThrow();
  });

  it("validates a file_dropped config", () => {
    expect(() => resolveTriggerConfig("file_dropped", { bucket: "inbound" })).not.toThrow();
    expect(() => resolveTriggerConfig("file_dropped", {})).toThrow();
  });

  it("validates an mcp_server_event config", () => {
    expect(() => resolveTriggerConfig("mcp_server_event", { connectionAlias: "notion", resourceUri: "notion://x" })).not.toThrow();
    expect(() => resolveTriggerConfig("mcp_server_event", { connectionAlias: "notion" })).toThrow();
  });

  it("validates a pagerduty_incident config", () => {
    expect(() => resolveTriggerConfig("pagerduty_incident", {
      webhookCredential: "pagerduty-webhook",
      rateLimitPerMin: 120,
    })).not.toThrow();
    expect(() => resolveTriggerConfig("pagerduty_incident", {})).toThrow();
  });
});

describe("webhookReceivedExecutor", () => {
  it("passes the normalized idempotent event to downstream nodes", async () => {
    const event = { eventId: "evt-1", payload: { service: "postgres" } };
    const result = await webhookReceivedExecutor(
      ctx({ endpointKey: "incident-triage" }, { input: { event } }),
    );
    expect(result).toMatchObject({
      status: "completed",
      output: { triggeredBy: "webhook_received", event },
    });
  });
});

describe("emailReceivedExecutor", () => {
  it("succeeds and passes the inbound event from run input through to downstream nodes", async () => {
    const event = { from: "alice@partner.com", subject: "Invoice", body: "pay me" };
    const result = await emailReceivedExecutor(ctx({ aliasKey: "ops" }, { input: { event } }));
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.output?.triggeredBy).toBe("email_received");
      expect(result.output?.event).toEqual(event);
      expect(typeof result.output?.triggeredAt).toBe("string");
    }
  });

  it("succeeds with an empty event on a manual start (no input.event block)", async () => {
    const result = await emailReceivedExecutor(ctx({ aliasKey: "ops" }));
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.output?.event).toEqual({});
    }
  });

  it("fails fast on a malformed config (no aliasKey)", async () => {
    await expect(emailReceivedExecutor(ctx({}))).rejects.toThrow();
  });
});

describe("pagerDutyIncidentExecutor", () => {
  it("passes the verified normalized event to the deterministic graph", async () => {
    const event = {
      eventId: "event-1",
      eventType: "incident.triggered",
      incidentId: "PINCIDENT1",
      occurredAt: "2026-07-24T03:30:00.000Z",
      receivedAt: "2026-07-24T03:31:00.000Z",
    };
    const result = await pagerDutyIncidentExecutor(ctx(
      { webhookCredential: "pagerduty-webhook" },
      { input: { event } },
    ));

    expect(result).toMatchObject({
      status: "completed",
      output: { triggeredBy: "pagerduty_incident", event },
    });
  });
});

describe("fileDroppedExecutor", () => {
  it("succeeds and passes the inbound object event through", async () => {
    const event = { bucket: "inbound", key: "uploads/report.csv" };
    const result = await fileDroppedExecutor(ctx({ bucket: "inbound" }, { input: { event } }));
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.output?.triggeredBy).toBe("file_dropped");
      expect(result.output?.event).toEqual(event);
    }
  });

  it("fails fast on a malformed config (no bucket)", async () => {
    await expect(fileDroppedExecutor(ctx({}))).rejects.toThrow();
  });
});

describe("mcpServerEventExecutor", () => {
  it("succeeds and passes the inbound resource event through", async () => {
    const event = { connectionAlias: "notion", resourceUri: "notion://db/1", eventType: "notifications/resources/updated" };
    const result = await mcpServerEventExecutor(
      ctx({ connectionAlias: "notion", resourceUri: "notion://db/1" }, { input: { event } }),
    );
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.output?.triggeredBy).toBe("mcp_server_event");
      expect(result.output?.event).toEqual(event);
    }
  });

  it("ignores a non-object event in input (defensive)", async () => {
    const result = await mcpServerEventExecutor(
      ctx({ connectionAlias: "notion", resourceUri: "notion://db/1" }, { input: { event: "not-an-object" } }),
    );
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.output?.event).toEqual({});
    }
  });
});

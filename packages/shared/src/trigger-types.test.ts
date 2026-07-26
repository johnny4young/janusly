/**
 * Tests for the inbound-trigger contract: per-type config schema validation,
 * normalized inbound-payload validation + size caps, the trigger-node type
 * guard, and the rate-limit resolver clamp.
 */

import { describe, expect, it, vi } from "vitest";
import {
  ATTACHMENT_MAX_BYTES,
  EMAIL_BODY_MAX_BYTES,
  EmailReceivedConfigSchema,
  EmailReceivedPayloadSchema,
  FileDroppedConfigSchema,
  FileDroppedPayloadSchema,
  MAX_ATTACHMENTS,
  McpServerEventConfigSchema,
  PagerDutyIncidentConfigSchema,
  McpServerEventPayloadSchema,
  WebhookReceivedConfigSchema,
  WebhookReceivedPayloadSchema,
  TRIGGER_DEFAULT_RATE_LIMIT_PER_MIN,
  TRIGGER_RATE_LIMIT_MAX_PER_MIN,
  isTriggerNodeType,
  resolveTriggerRateLimitPerMin,
  triggerNodeTypeValues,
  utf8ByteLength,
} from "./trigger-types";

describe("isTriggerNodeType", () => {
  it("recognizes the event-driven trigger types", () => {
    expect(isTriggerNodeType("webhook_received")).toBe(true);
    expect(isTriggerNodeType("email_received")).toBe(true);
    expect(isTriggerNodeType("file_dropped")).toBe(true);
    expect(isTriggerNodeType("mcp_server_event")).toBe(true);
  });

  it("rejects non-trigger node types and junk", () => {
    expect(isTriggerNodeType("http")).toBe(false);
    expect(isTriggerNodeType("schedule")).toBe(false);
    expect(isTriggerNodeType("")).toBe(false);
    expect(isTriggerNodeType(undefined)).toBe(false);
    expect(isTriggerNodeType(42)).toBe(false);
  });

  it("the closed enum has exactly the supported trigger types", () => {
    expect([...triggerNodeTypeValues]).toEqual([
      "webhook_received",
      "email_received",
      "file_dropped",
      "mcp_server_event",
      "pagerduty_incident",
    ]);
  });
});

describe("PagerDutyIncidentConfigSchema (config validation)", () => {
  it("requires a stored signing credential and bounds the ingress rate", () => {
    expect(PagerDutyIncidentConfigSchema.safeParse({
      webhookCredential: "pagerduty-webhook",
      rateLimitPerMin: 120,
    }).success).toBe(true);
    expect(PagerDutyIncidentConfigSchema.safeParse({}).success).toBe(false);
    expect(PagerDutyIncidentConfigSchema.safeParse({
      webhookCredential: "pagerduty-webhook",
      rateLimitPerMin: 0,
    }).success).toBe(false);
  });
});

describe("WebhookReceivedConfigSchema (config validation)", () => {
  it("accepts a bounded endpoint key and rejects URL-shaped values", () => {
    expect(WebhookReceivedConfigSchema.safeParse({ endpointKey: "incident-triage" }).success).toBe(true);
    expect(WebhookReceivedConfigSchema.safeParse({ endpointKey: "https://example.com/hook" }).success).toBe(false);
  });
});

describe("EmailReceivedConfigSchema (config validation)", () => {
  it("accepts a valid alias-key config", () => {
    const parsed = EmailReceivedConfigSchema.safeParse({ aliasKey: "support+ops", dkimRequired: true });
    expect(parsed.success).toBe(true);
  });

  it("rejects a missing alias key", () => {
    const parsed = EmailReceivedConfigSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it("rejects an alias key with an `@` (must be a local-part only)", () => {
    const parsed = EmailReceivedConfigSchema.safeParse({ aliasKey: "support@example.com" });
    expect(parsed.success).toBe(false);
  });

  it("rejects an out-of-range rate limit", () => {
    const parsed = EmailReceivedConfigSchema.safeParse({ aliasKey: "ops", rateLimitPerMin: TRIGGER_RATE_LIMIT_MAX_PER_MIN + 1 });
    expect(parsed.success).toBe(false);
  });

  it("passes through unknown keys (loose posture)", () => {
    const parsed = EmailReceivedConfigSchema.safeParse({ aliasKey: "ops", futureField: "x" });
    expect(parsed.success).toBe(true);
  });
});

describe("FileDroppedConfigSchema (config validation)", () => {
  it("accepts a valid bucket + prefix config", () => {
    const parsed = FileDroppedConfigSchema.safeParse({ bucket: "inbound", prefix: "uploads/" });
    expect(parsed.success).toBe(true);
  });

  it("rejects a missing bucket", () => {
    expect(FileDroppedConfigSchema.safeParse({ prefix: "uploads/" }).success).toBe(false);
  });
});

describe("McpServerEventConfigSchema (config validation)", () => {
  it("accepts a valid connection + resource config", () => {
    const parsed = McpServerEventConfigSchema.safeParse({ connectionAlias: "notion", resourceUri: "notion://db/123" });
    expect(parsed.success).toBe(true);
  });

  it("rejects a missing resource uri", () => {
    expect(McpServerEventConfigSchema.safeParse({ connectionAlias: "notion" }).success).toBe(false);
  });
});

describe("inbound payload schemas (size caps + shape)", () => {
  it("requires an idempotency identity for generic webhooks", () => {
    expect(WebhookReceivedPayloadSchema.safeParse({
      endpointKey: "incident-triage",
      eventId: "evt-1",
      eventType: "database.connection_exhausted",
      payload: { service: "postgres" },
    }).success).toBe(true);
    expect(WebhookReceivedPayloadSchema.safeParse({ endpointKey: "incident-triage" }).success).toBe(false);
  });

  it("accepts a normalized email payload", () => {
    const parsed = EmailReceivedPayloadSchema.safeParse({
      aliasKey: "ops",
      from: "alice@partner.com",
      subject: "Invoice",
      body: "Please process the attached invoice.",
      dkimPass: true,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // Defaults apply for omitted fields.
      expect(parsed.data.attachments).toEqual([]);
    }
  });

  it("rejects an email payload with more than MAX_ATTACHMENTS", () => {
    const attachments = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => ({ filename: `f${i}.pdf` }));
    const parsed = EmailReceivedPayloadSchema.safeParse({ aliasKey: "ops", from: "a@b.com", attachments });
    expect(parsed.success).toBe(false);
  });

  it("rejects an attachment whose reported size exceeds the per-attachment cap", () => {
    const parsed = EmailReceivedPayloadSchema.safeParse({
      aliasKey: "ops",
      from: "a@b.com",
      attachments: [{ filename: "big.bin", sizeBytes: ATTACHMENT_MAX_BYTES + 1 }],
    });
    expect(parsed.success).toBe(false);
  });

  it("measures the 1 MiB body cap in UTF-8 bytes", () => {
    // A 1 MiB ASCII string is exactly at the cap; one more byte is over.
    const atCap = "a".repeat(EMAIL_BODY_MAX_BYTES);
    expect(utf8ByteLength(atCap)).toBe(EMAIL_BODY_MAX_BYTES);
    const overCap = "a".repeat(EMAIL_BODY_MAX_BYTES + 1);
    expect(utf8ByteLength(overCap)).toBe(EMAIL_BODY_MAX_BYTES + 1);
    // Multi-byte chars count their encoded length, not their JS string length.
    expect(utf8ByteLength("é")).toBe(2);
  });

  it("does not require the Node Buffer global", () => {
    const originalBuffer = (globalThis as { Buffer?: unknown }).Buffer;
    vi.stubGlobal("Buffer", undefined);
    try {
      expect(utf8ByteLength("Janusly 🧭")).toBe(12);
    } finally {
      vi.stubGlobal("Buffer", originalBuffer);
    }
  });

  it("accepts a normalized file-dropped payload", () => {
    const parsed = FileDroppedPayloadSchema.safeParse({ bucket: "inbound", key: "uploads/report.csv", etag: "abc123" });
    expect(parsed.success).toBe(true);
  });

  it("accepts a normalized MCP server-event payload", () => {
    const parsed = McpServerEventPayloadSchema.safeParse({
      connectionAlias: "notion",
      resourceUri: "notion://db/123",
      eventType: "notifications/resources/updated",
      payload: { changed: true },
    });
    expect(parsed.success).toBe(true);
  });
});

describe("resolveTriggerRateLimitPerMin (storm-guard clamp)", () => {
  it("falls back to the default for unset / invalid values", () => {
    expect(resolveTriggerRateLimitPerMin(undefined)).toBe(TRIGGER_DEFAULT_RATE_LIMIT_PER_MIN);
    expect(resolveTriggerRateLimitPerMin("nope")).toBe(TRIGGER_DEFAULT_RATE_LIMIT_PER_MIN);
    expect(resolveTriggerRateLimitPerMin(Number.NaN)).toBe(TRIGGER_DEFAULT_RATE_LIMIT_PER_MIN);
  });

  it("clamps to the [1, MAX] range", () => {
    expect(resolveTriggerRateLimitPerMin(0)).toBe(1);
    expect(resolveTriggerRateLimitPerMin(-5)).toBe(1);
    expect(resolveTriggerRateLimitPerMin(TRIGGER_RATE_LIMIT_MAX_PER_MIN + 1000)).toBe(TRIGGER_RATE_LIMIT_MAX_PER_MIN);
  });

  it("floors fractional values inside the range", () => {
    expect(resolveTriggerRateLimitPerMin(12.9)).toBe(12);
  });
});

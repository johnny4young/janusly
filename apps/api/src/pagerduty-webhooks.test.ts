import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  parsePagerDutyWebhook,
  verifyPagerDutySignature,
} from "./pagerduty-webhooks";

const secret = "pagerduty-webhook-secret";
const rawBody = JSON.stringify({
  event: {
    id: "event-1",
    event_type: "incident.triggered",
    occurred_at: "2026-07-23T23:30:00-05:00",
    data: {
      type: "incident",
      id: "PINCIDENT1",
      title: "Database connection exhaustion",
      urgency: "high",
      service: { id: "PSERVICE1", type: "service_reference" },
    },
  },
});

describe("PagerDuty V3 signature verification", () => {
  it("accepts any matching comma-separated v1 signature over the exact raw body", () => {
    const valid = createHmac("sha256", secret).update(rawBody).digest("hex");
    expect(verifyPagerDutySignature(rawBody, `v1=${"0".repeat(64)}, v1=${valid}`, secret)).toBe(true);
  });

  it("rejects malformed, modified, or missing signature inputs", () => {
    const valid = createHmac("sha256", secret).update(rawBody).digest("hex");
    expect(verifyPagerDutySignature(`${rawBody}\n`, `v1=${valid}`, secret)).toBe(false);
    expect(verifyPagerDutySignature(rawBody, "v1=not-hex", secret)).toBe(false);
    expect(verifyPagerDutySignature(rawBody, null, secret)).toBe(false);
    expect(verifyPagerDutySignature(rawBody, `v1=${valid}`, "")).toBe(false);
  });
});

describe("PagerDuty V3 bounded projection", () => {
  it("projects only durable incident fields", () => {
    expect(parsePagerDutyWebhook(rawBody)).toEqual({
      eventId: "event-1",
      eventType: "incident.triggered",
      incidentId: "PINCIDENT1",
      incidentTitle: "Database connection exhaustion",
      serviceId: "PSERVICE1",
      urgency: "high",
      occurredAt: new Date("2026-07-23T23:30:00-05:00"),
    });
  });

  it("supports nested incident payloads and rejects malformed bodies", () => {
    const nested = JSON.stringify({
      event: {
        id: "event-2",
        event_type: "incident.reassigned",
        data: {
          type: "assignment",
          incident: { id: "PINCIDENT2", title: "Nested incident" },
        },
      },
    });
    expect(parsePagerDutyWebhook(nested)).toMatchObject({
      eventId: "event-2",
      incidentId: "PINCIDENT2",
      incidentTitle: "Nested incident",
    });
    expect(parsePagerDutyWebhook("{")).toBeNull();
    expect(parsePagerDutyWebhook(JSON.stringify({ event: { id: "event-3", event_type: "incident.triggered", data: {} } }))).toBeNull();
  });
});

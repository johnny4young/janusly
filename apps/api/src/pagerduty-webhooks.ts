/**
 * Pure PagerDuty V3 webhook verification and bounded projection.
 *
 * The signature follows PagerDuty's official V3 contract: one or more
 * comma-separated `v1=<hex HMAC-SHA256(raw-body)>` values. The raw body is
 * verified before JSON parsing. Only the fields needed by the deterministic
 * workflow leave this module.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const EventSchema = z.object({
  id: z.string().min(1).max(300),
  event_type: z.string().min(1).max(120),
  occurred_at: z.string().datetime({ offset: true }).optional(),
  data: z.object({
    id: z.string().min(1).max(300).optional(),
    type: z.string().max(100).optional(),
    title: z.string().max(2_000).optional(),
    urgency: z.string().max(100).optional(),
    service: z.object({
      id: z.string().min(1).max(300),
    }).passthrough().optional(),
    incident: z.object({
      id: z.string().min(1).max(300),
      title: z.string().max(2_000).optional(),
      urgency: z.string().max(100).optional(),
      service: z.object({
        id: z.string().min(1).max(300),
      }).passthrough().optional(),
    }).passthrough().optional(),
  }).passthrough(),
}).passthrough();

const PayloadSchema = z.object({ event: EventSchema }).passthrough();

export type PagerDutyWebhookEvent = {
  eventId: string;
  eventType: string;
  incidentId: string;
  incidentTitle: string | null;
  serviceId: string | null;
  urgency: string | null;
  occurredAt: Date | null;
};

/** Constant-time verification against every v1 signature in the header. */
export function verifyPagerDutySignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): boolean {
  if (!rawBody || !signatureHeader || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  for (const item of signatureHeader.split(",")) {
    const value = item.trim();
    if (!value.startsWith("v1=")) continue;
    const hex = value.slice(3);
    if (!/^[0-9a-f]{64}$/iu.test(hex)) continue;
    const candidate = Buffer.from(hex, "hex");
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return true;
  }
  return false;
}

/** Parse only the durable, non-secret incident projection. */
export function parsePagerDutyWebhook(rawBody: string): PagerDutyWebhookEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const parsed = PayloadSchema.safeParse(json);
  if (!parsed.success) return null;
  const { event } = parsed.data;
  const incident = event.data.type === "incident"
    ? event.data
    : event.data.incident;
  const incidentId = incident?.id ?? event.data.id;
  if (!incidentId) return null;
  const occurredAt = event.occurred_at ? new Date(event.occurred_at) : null;
  return {
    eventId: event.id,
    eventType: event.event_type,
    incidentId,
    incidentTitle: incident?.title ?? event.data.title ?? null,
    serviceId: incident?.service?.id ?? event.data.service?.id ?? null,
    urgency: incident?.urgency ?? event.data.urgency ?? null,
    occurredAt: occurredAt && !Number.isNaN(occurredAt.getTime()) ? occurredAt : null,
  };
}


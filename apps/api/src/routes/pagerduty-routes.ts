/**
 * Provider-signed PagerDuty trigger ingestion.
 *
 * The callback path selects one saved workflow + node. It is not authority:
 * the exact raw body must verify against the node's tenant-scoped Secret Store
 * credential before the shared durable trigger pipeline can persist an event
 * or start a run.
 */

import {
  recordSystemAudit,
  resolveCredentialSecret,
  resolvePublicTriggerNode,
} from "@janusly/data";
import {
  PagerDutyIncidentConfigSchema,
  PagerDutyIncidentPayloadSchema,
} from "@janusly/shared/src/trigger-types";

import type { AuthContext } from "../auth";
import { readRawBody, sendError, sendJson } from "../http";
import {
  parsePagerDutyWebhook,
  verifyPagerDutySignature,
} from "../pagerduty-webhooks";
import type { Route } from "../routes";
import { persistEventAndSpawnRun } from "./trigger-ingest-routes";

const WEBHOOK_BODY_MAX_BYTES = 2 * 1024 * 1024;
const CALLBACK = /^\/webhooks\/pagerduty\/([^/?]+)\/([^/?]+)$/u;

function decodePathPart(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function callbackParts(url: string | undefined): { workflowId: string; nodeId: string } | null {
  const match = CALLBACK.exec((url ?? "").split("?", 1)[0] ?? "");
  const workflowId = decodePathPart(match?.[1]);
  const nodeId = decodePathPart(match?.[2]);
  return workflowId && nodeId ? { workflowId, nodeId } : null;
}

function systemAuth(orgId: string): AuthContext {
  return {
    orgId,
    userId: "system:pagerduty",
    mode: "service-token",
    source: "service",
  };
}

export const pagerDutyRoutes: Route[] = [
  {
    method: "POST",
    match: (url) => CALLBACK.test(url.split("?", 1)[0] ?? ""),
    skipAuth: true,
    handler: async ({ req, res }) => {
      const selected = callbackParts(req.url);
      if (!selected) {
        return sendError(res, "pagerduty_invalid_request", "invalid PagerDuty callback path", 400);
      }

      const target = await resolvePublicTriggerNode(
        selected.workflowId,
        "pagerduty_incident",
        selected.nodeId,
      );
      if (!target) {
        return sendError(res, "pagerduty_trigger_not_found", "PagerDuty trigger not found", 404);
      }

      const config = PagerDutyIncidentConfigSchema.safeParse(target.resolved.nodeConfig);
      if (!config.success) {
        return sendError(res, "pagerduty_invalid_request", "PagerDuty trigger is not configured", 422);
      }

      const [rawBody, signingSecret] = await Promise.all([
        readRawBody(req, WEBHOOK_BODY_MAX_BYTES),
        resolveCredentialSecret(
          target.orgId,
          "pagerduty_webhook_secret",
          config.data.webhookCredential,
        ),
      ]);
      const rawSignature = req.headers["x-pagerduty-signature"];
      const signature = Array.isArray(rawSignature) ? rawSignature[0] ?? null : rawSignature ?? null;
      if (!verifyPagerDutySignature(rawBody, signature, signingSecret ?? "")) {
        return sendError(res, "pagerduty_invalid_signature", "invalid PagerDuty signature", 403);
      }

      const event = parsePagerDutyWebhook(rawBody);
      if (!event) {
        return sendError(res, "pagerduty_invalid_request", "invalid PagerDuty webhook payload", 400);
      }
      const receivedAt = new Date().toISOString();
      const payload = PagerDutyIncidentPayloadSchema.parse({
        eventId: event.eventId,
        eventType: event.eventType,
        incidentId: event.incidentId,
        incidentTitle: event.incidentTitle,
        serviceId: event.serviceId,
        urgency: event.urgency,
        occurredAt: event.occurredAt?.toISOString() ?? receivedAt,
        receivedAt,
      });

      const result = await persistEventAndSpawnRun({
        auth: systemAuth(target.orgId),
        triggerType: "pagerduty_incident",
        resolved: target.resolved,
        payload,
        dedupeKey: `pagerduty:${selected.workflowId}:${selected.nodeId}:${event.eventId}`,
        auditEvent: async (action, options) => {
          await recordSystemAudit({
            orgId: target.orgId,
            action,
            actor: "system:pagerduty",
            targetType: options.targetType,
            targetId: options.targetId,
            metadata: options.metadata,
            logTag: "[pagerduty]",
          });
        },
      });
      return sendJson(res, result.body, result.status);
    },
  },
];

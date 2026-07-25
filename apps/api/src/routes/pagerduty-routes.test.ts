/**
 * Route-level tests for the provider-signed PagerDuty workflow trigger.
 *
 * The pure signature and payload projection live in
 * `pagerduty-webhooks.test.ts`; this suite proves that a public selector is
 * never trusted without a tenant-scoped signing secret and that accepted
 * deliveries enter the shared durable trigger pipeline.
 */

import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dataMocks = vi.hoisted(() => ({
  recordSystemAudit: vi.fn(async () => undefined),
  resolveCredentialSecret: vi.fn(),
  resolvePublicTriggerNode: vi.fn(),
}));
const triggerMocks = vi.hoisted(() => ({
  persistEventAndSpawnRun: vi.fn(),
}));
const httpMocks = vi.hoisted(() => ({
  readRawBody: vi.fn(),
  sendJson: vi.fn((_res: unknown, payload: unknown, status = 200) => ({ payload, status })),
}));

vi.mock("@janusly/data", () => dataMocks);
vi.mock("./trigger-ingest-routes", () => triggerMocks);
vi.mock("../http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../http")>();
  return {
    ...actual,
    readRawBody: httpMocks.readRawBody,
    sendJson: httpMocks.sendJson,
    sendError: vi.fn((
      res: unknown,
      code: string,
      message: string,
      status = 400,
    ) => httpMocks.sendJson(res, { error: message, code }, status)),
  };
});

import type { Route } from "../routes";
import { pagerDutyRoutes } from "./pagerduty-routes";

const workflowId = "wf-pagerduty";
const nodeId = "on_pagerduty";
const webhookSecret = "pagerduty-signing-secret";
const callback = `/webhooks/pagerduty/${workflowId}/${nodeId}`;
const resolved = {
  workflowId,
  workflowVersionId: "ver-pagerduty",
  nodeId,
  nodeConfig: {
    webhookCredential: "pagerduty-webhook",
    rateLimitPerMin: 120,
  },
  dagJson: {
    dslVersion: "1.0",
    nodes: [{ id: nodeId, type: "pagerduty_incident", config: {
      webhookCredential: "pagerduty-webhook",
      rateLimitPerMin: 120,
    } }],
    edges: [],
  },
};

function route(path = callback): Route {
  const found = pagerDutyRoutes.find((candidate) => (
    candidate.method === "POST"
    && (typeof candidate.match === "string" ? candidate.match === path : candidate.match(path))
  ));
  if (!found) throw new Error(`route not found: POST ${path}`);
  return found;
}

function webhookBody() {
  return JSON.stringify({
    event: {
      id: "event-1",
      event_type: "incident.triggered",
      occurred_at: "2026-07-23T23:30:00-05:00",
      data: {
        type: "incident",
        id: "PINCIDENT1",
        title: "Database connection exhaustion",
        urgency: "high",
        service: { id: "PSERVICE1" },
      },
    },
  });
}

async function call(rawBody: string, signature?: string, path = callback) {
  httpMocks.readRawBody.mockResolvedValue(rawBody);
  return route(path).handler({
    req: {
      url: path,
      headers: signature ? { "x-pagerduty-signature": signature } : {},
    } as never,
    res: {} as never,
    auth: {} as never,
  }) as Promise<{ payload: Record<string, unknown>; status: number }>;
}

beforeEach(() => {
  vi.clearAllMocks();
  dataMocks.resolvePublicTriggerNode.mockResolvedValue({ orgId: "org-1", resolved });
  dataMocks.resolveCredentialSecret.mockResolvedValue(webhookSecret);
  triggerMocks.persistEventAndSpawnRun.mockResolvedValue({
    body: { accepted: true, duplicate: false, eventId: "trigger-event-1", runId: "run-1" },
    status: 202,
  });
});

describe("PagerDuty workflow callback", () => {
  it("is public but exact-workflow scoped", () => {
    expect(route().skipAuth).toBe(true);
    expect(pagerDutyRoutes).toHaveLength(1);
    expect(route(`${callback}?source=pagerduty`)).toBeDefined();
  });

  it("verifies the exact body and enters shared durable ingestion", async () => {
    const raw = webhookBody();
    const signature = `v1=${createHmac("sha256", webhookSecret).update(raw).digest("hex")}`;

    const response = await call(raw, signature);

    expect(response).toEqual({
      payload: {
        accepted: true,
        duplicate: false,
        eventId: "trigger-event-1",
        runId: "run-1",
      },
      status: 202,
    });
    expect(dataMocks.resolvePublicTriggerNode).toHaveBeenCalledWith(
      workflowId,
      "pagerduty_incident",
      nodeId,
    );
    expect(dataMocks.resolveCredentialSecret).toHaveBeenCalledWith(
      "org-1",
      "pagerduty_webhook_secret",
      "pagerduty-webhook",
    );
    expect(triggerMocks.persistEventAndSpawnRun).toHaveBeenCalledWith(expect.objectContaining({
      auth: expect.objectContaining({ orgId: "org-1", userId: "system:pagerduty" }),
      triggerType: "pagerduty_incident",
      resolved,
      dedupeKey: `pagerduty:${workflowId}:${nodeId}:event-1`,
      payload: expect.objectContaining({
        eventId: "event-1",
        eventType: "incident.triggered",
        incidentId: "PINCIDENT1",
        serviceId: "PSERVICE1",
      }),
      auditEvent: expect.any(Function),
    }));
  });

  it("rejects an invalid signature before trigger ingestion", async () => {
    const response = await call(webhookBody(), `v1=${"0".repeat(64)}`);

    expect(response.status).toBe(403);
    expect(response.payload.code).toBe("pagerduty_invalid_signature");
    expect(triggerMocks.persistEventAndSpawnRun).not.toHaveBeenCalled();
  });

  it("fails closed for missing targets, malformed config, and invalid payloads", async () => {
    dataMocks.resolvePublicTriggerNode.mockResolvedValueOnce(null);
    const missing = await call(webhookBody(), "v1=ignored");
    expect(missing).toMatchObject({ status: 404, payload: { code: "pagerduty_trigger_not_found" } });

    dataMocks.resolvePublicTriggerNode.mockResolvedValueOnce({
      orgId: "org-1",
      resolved: { ...resolved, nodeConfig: {} },
    });
    const badConfig = await call(webhookBody(), "v1=ignored");
    expect(badConfig).toMatchObject({ status: 422, payload: { code: "pagerduty_invalid_request" } });

    const invalidRaw = JSON.stringify({ event: { id: "event-1" } });
    const signature = `v1=${createHmac("sha256", webhookSecret).update(invalidRaw).digest("hex")}`;
    const badPayload = await call(invalidRaw, signature);
    expect(badPayload).toMatchObject({ status: 400, payload: { code: "pagerduty_invalid_request" } });
  });

  it("writes system audit through the shared ingestion adapter", async () => {
    const raw = webhookBody();
    const signature = `v1=${createHmac("sha256", webhookSecret).update(raw).digest("hex")}`;
    await call(raw, signature);

    const input = triggerMocks.persistEventAndSpawnRun.mock.calls[0]?.[0];
    await input.auditEvent("trigger.event.started", {
      targetType: "trigger_event",
      targetId: "trigger-event-1",
      metadata: { workflowId },
    });
    expect(dataMocks.recordSystemAudit).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "org-1",
      actor: "system:pagerduty",
      action: "trigger.event.started",
      targetId: "trigger-event-1",
    }));
  });
});

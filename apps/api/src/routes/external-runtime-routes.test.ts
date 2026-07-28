import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dataMocks = vi.hoisted(() => ({
  create: vi.fn(),
  delete: vi.fn(),
  get: vi.fn(),
  getCallback: vi.fn(),
  getCredential: vi.fn(),
  hasSecret: vi.fn(),
  listCases: vi.fn(),
  listConnections: vi.fn(),
  listRuns: vi.fn(),
  listSteps: vi.fn(),
  listWorkflows: vi.fn(),
  record: vi.fn(),
  resolveSecret: vi.fn(),
  update: vi.fn(),
}));

const httpMocks = vi.hoisted(() => ({
  readJson: vi.fn(),
  readRawBody: vi.fn(),
  sendJson: vi.fn((_res: unknown, payload: unknown, status = 200) => ({ payload, status })),
}));

vi.mock("@janusly/data", () => ({
  createExternalRuntimeConnection: dataMocks.create,
  deleteExternalRuntimeConnection: dataMocks.delete,
  EXTERNAL_RUNTIME_CONNECTION_NAME_MAX: 120,
  EXTERNAL_RUNTIME_CREDENTIAL_NAME_MAX: 200,
  EXTERNAL_RUNTIME_KEY_MAX: 120,
  getCredentialByName: dataMocks.getCredential,
  getExternalRuntimeConnection: dataMocks.get,
  getExternalRuntimeConnectionForCallback: dataMocks.getCallback,
  hasCredentialSecretRef: dataMocks.hasSecret,
  listExternalRecoveryCases: dataMocks.listCases,
  listExternalRunSteps: dataMocks.listSteps,
  listExternalRuns: dataMocks.listRuns,
  listExternalRuntimeConnections: dataMocks.listConnections,
  listExternalWorkflows: dataMocks.listWorkflows,
  recordExternalRuntimeEvent: dataMocks.record,
  resolveCredentialSecretRef: dataMocks.resolveSecret,
  updateExternalRuntimeConnection: dataMocks.update,
}));

vi.mock("../http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../http")>();
  return {
    ...actual,
    readJson: httpMocks.readJson,
    readRawBody: httpMocks.readRawBody,
    sendJson: httpMocks.sendJson,
    sendError: vi.fn((res: unknown, code: string, message: string, status = 400) =>
      httpMocks.sendJson(res, { error: message, code }, status)),
  };
});
vi.mock("../audit-helper", () => ({ auditAction: vi.fn() }));

import { auditAction } from "../audit-helper";
import type { Route } from "../routes";
import { externalRuntimeRoutes } from "./external-runtime-routes";

const auth = { orgId: "org-1", userId: "admin-1", mode: "dev-headers", source: "dev" } as never;
const secret = "external-runtime-signing-secret";
const connection = {
  id: "external-1",
  orgId: "org-1",
  name: "Temporal production",
  runtimeKey: "temporal-prod",
  signingCredentialName: "temporal-observer",
  enabled: true,
  createdBy: "admin-1",
  createdAt: new Date("2026-07-27T00:00:00.000Z"),
  updatedAt: new Date("2026-07-27T00:00:00.000Z"),
};

const event = {
  specversion: "1.0",
  id: "event-1",
  source: "urn:temporal:payments",
  type: "io.janusly.external.run.observed",
  time: "2026-07-27T12:30:00.000Z",
  data: {
    externalWorkflowId: "payments",
    externalRunId: "run-1",
    sequence: 2,
    status: "failed",
  },
};

function findRoute(method: string, path: string): Route {
  const route = externalRuntimeRoutes.find((entry) => {
    if (entry.method !== method) return false;
    return typeof entry.match === "string" ? entry.match === path : entry.match(path);
  });
  if (!route) throw new Error(`route not found: ${method} ${path}`);
  return route;
}

function sign(rawBody: string, timestamp = Math.floor(Date.now() / 1_000)): string {
  return `t=${timestamp},v1=${createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex")}`;
}

async function callAdmin(method: string, path: string) {
  return findRoute(method, path).handler({
    req: { url: path } as never,
    res: {} as never,
    auth,
  });
}

async function callCallback(signatureHeader: string) {
  return findRoute("POST", "/webhooks/external-runtimes/external-1").handler({
    req: {
      url: "/webhooks/external-runtimes/external-1",
      headers: { "x-janusly-signature": signatureHeader },
    } as never,
    res: {} as never,
    auth: {} as never,
  });
}

beforeEach(() => {
  dataMocks.getCallback.mockResolvedValue(connection);
  dataMocks.getCredential.mockResolvedValue({
    kind: "external_runtime_signing_secret",
    secretRef: "managed://external-1",
  });
  dataMocks.hasSecret.mockResolvedValue(true);
  dataMocks.resolveSecret.mockResolvedValue(secret);
  dataMocks.listConnections.mockResolvedValue([]);
  dataMocks.listWorkflows.mockResolvedValue([]);
  dataMocks.listRuns.mockResolvedValue([]);
  dataMocks.listSteps.mockResolvedValue([]);
  dataMocks.listCases.mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("external runtime route gates", () => {
  it("separates read, write, and unauthenticated callback authority", () => {
    expect(findRoute("GET", "/integrations/external-runtimes")).toMatchObject({
      permission: "external-runtimes.read",
    });
    expect(findRoute("POST", "/integrations/external-runtimes")).toMatchObject({
      role: "admin",
      permission: "external-runtimes.write",
    });
    expect(findRoute("POST", "/webhooks/external-runtimes/external-1").skipAuth).toBe(true);
  });
});

describe("signed external runtime callback", () => {
  it("verifies the exact body and records one validated observation", async () => {
    const rawBody = JSON.stringify(event);
    httpMocks.readRawBody.mockResolvedValue(rawBody);
    dataMocks.record.mockResolvedValue({
      kind: "applied",
      receipt: {
        eventId: "event-1",
        projectionState: "applied",
        receivedAt: new Date("2026-07-27T12:30:01.000Z"),
      },
    });

    await callCallback(sign(rawBody));

    expect(dataMocks.getCredential).toHaveBeenCalledWith(
      "org-1",
      "external_runtime_signing_secret",
      "temporal-observer",
    );
    expect(dataMocks.record).toHaveBeenCalledWith({
      orgId: "org-1",
      connectionId: "external-1",
      event: expect.objectContaining({ id: "event-1", data: expect.objectContaining({ sequence: 2 }) }),
    });
    expect(httpMocks.sendJson.mock.calls.at(-1)?.[1]).toMatchObject({
      accepted: true,
      duplicate: false,
      projectionState: "applied",
    });
    expect(httpMocks.sendJson.mock.calls.at(-1)?.[2]).toBe(202);
  });

  it("rejects an invalid signature before parsing or persistence", async () => {
    httpMocks.readRawBody.mockResolvedValue(JSON.stringify(event));
    await callCallback(`t=${Math.floor(Date.now() / 1_000)},v1=${"0".repeat(64)}`);
    expect(dataMocks.record).not.toHaveBeenCalled();
    expect(httpMocks.sendJson.mock.calls.at(-1)?.[2]).toBe(401);
  });

  it("returns an idempotent accepted response for an exact retry", async () => {
    const rawBody = JSON.stringify(event);
    httpMocks.readRawBody.mockResolvedValue(rawBody);
    dataMocks.record.mockResolvedValue({
      kind: "duplicate",
      receipt: {
        eventId: "event-1",
        projectionState: "stale",
        receivedAt: new Date("2026-07-27T12:30:01.000Z"),
      },
    });
    await callCallback(sign(rawBody));
    expect(httpMocks.sendJson.mock.calls.at(-1)?.[1]).toMatchObject({
      accepted: true,
      duplicate: true,
      projectionState: "stale",
    });
  });

  it("fails when the connection is revoked at the transactional claim boundary", async () => {
    const rawBody = JSON.stringify(event);
    httpMocks.readRawBody.mockResolvedValue(rawBody);
    dataMocks.record.mockResolvedValue({ kind: "connection_not_found" });
    await callCallback(sign(rawBody));
    expect(httpMocks.sendJson.mock.calls.at(-1)?.[2]).toBe(404);
  });

  it("maps secret-shaped external identities to a safe client error", async () => {
    const rawBody = JSON.stringify(event);
    httpMocks.readRawBody.mockResolvedValue(rawBody);
    dataMocks.record.mockRejectedValue(new Error("external_runtime_sensitive_identity"));
    await callCallback(sign(rawBody));
    expect(httpMocks.sendJson.mock.calls.at(-1)?.[1]).toMatchObject({
      code: "external_runtime_invalid_request",
    });
    expect(httpMocks.sendJson.mock.calls.at(-1)?.[2]).toBe(400);
  });
});

describe("external runtime admin projection", () => {
  it("lists the complete bounded shadow without secret references", async () => {
    dataMocks.listConnections.mockResolvedValue([connection]);
    dataMocks.listCases.mockResolvedValue([{ id: "case-1", state: "detected" }]);
    await callAdmin("GET", "/integrations/external-runtimes");
    const payload = httpMocks.sendJson.mock.calls.at(-1)?.[1];
    expect(payload).toMatchObject({
      observerOnly: true,
      connections: [{
        id: "external-1",
        callbackUrl: "/webhooks/external-runtimes/external-1",
      }],
      cases: [{ id: "case-1", state: "detected" }],
    });
    expect(JSON.stringify(payload)).not.toContain("secretRef");
    expect(JSON.stringify(payload)).not.toContain("managed://");
  });

  it("validates the dedicated signing credential before create", async () => {
    httpMocks.readJson.mockResolvedValue({
      name: "Temporal production",
      runtimeKey: "temporal-prod",
      signingCredentialName: "temporal-observer",
      enabled: true,
    });
    dataMocks.create.mockResolvedValue(connection);
    await callAdmin("POST", "/integrations/external-runtimes");
    expect(dataMocks.hasSecret).toHaveBeenCalledWith("org-1", "managed://external-1");
    expect(dataMocks.create).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "org-1",
      createdBy: "admin-1",
    }));
    expect(auditAction).toHaveBeenCalledWith(
      auth,
      "external_runtime.connection.created",
      expect.anything(),
    );
    expect(httpMocks.sendJson.mock.calls.at(-1)?.[2]).toBe(201);
  });
});

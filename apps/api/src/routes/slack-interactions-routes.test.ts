import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dataMocks = vi.hoisted(() => ({
  apply: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
  getCredential: vi.fn(),
  hasSecret: vi.fn(),
  getMember: vi.fn(),
  get: vi.fn(),
  getCallback: vi.fn(),
  list: vi.fn(),
  resolveSecret: vi.fn(),
  resolveUser: vi.fn(),
  update: vi.fn(),
}));

const httpMocks = vi.hoisted(() => ({
  readJson: vi.fn(),
  readRawBody: vi.fn(),
  sendJson: vi.fn((_res: unknown, payload: unknown, status = 200) => ({ payload, status })),
}));

vi.mock("@janusly/data", () => ({
  applySlackRecoveryInteraction: dataMocks.apply,
  createSlackInteractionConnection: dataMocks.create,
  deleteSlackInteractionConnection: dataMocks.delete,
  getCredentialByName: dataMocks.getCredential,
  hasCredentialSecretRef: dataMocks.hasSecret,
  getMembershipForOrgUser: dataMocks.getMember,
  getSlackInteractionConnection: dataMocks.get,
  getSlackInteractionConnectionForCallback: dataMocks.getCallback,
  listSlackInteractionConnections: dataMocks.list,
  resolveCredentialSecretRef: dataMocks.resolveSecret,
  resolveSlackInteractionUser: dataMocks.resolveUser,
  SLACK_INTERACTION_CONNECTION_NAME_MAX: 120,
  SLACK_INTERACTION_CREDENTIAL_NAME_MAX: 200,
  SLACK_INTERACTION_TEAM_ID_MAX: 64,
  SLACK_INTERACTION_USER_ID_MAX: 128,
  SLACK_INTERACTION_USER_MAPPINGS_MAX: 100,
  updateSlackInteractionConnection: dataMocks.update,
}));

vi.mock("../http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../http")>();
  return {
    ...actual,
    readJson: httpMocks.readJson,
    readRawBody: httpMocks.readRawBody,
    sendJson: httpMocks.sendJson,
    sendError: vi.fn((res: unknown, code: string, message: string, status = 400, params?: Record<string, unknown>) =>
      httpMocks.sendJson(res, params ? { error: message, code, params } : { error: message, code }, status)),
  };
});

vi.mock("../audit", () => ({ audit: vi.fn() }));
vi.mock("../audit-helper", () => ({ auditAction: vi.fn() }));
vi.mock("../permissions", () => ({ requirePermission: vi.fn(), requireRole: vi.fn() }));

import { audit } from "../audit";
import { auditAction } from "../audit-helper";
import { requirePermission, requireRole } from "../permissions";
import type { Route } from "../routes";
import { slackInteractionsRoutes } from "./slack-interactions-routes";

const auth = { orgId: "org-1", userId: "admin-1", mode: "dev-headers", source: "dev" } as never;
const secret = "slack-signing-secret";
const connection = {
  id: "connection-1",
  orgId: "org-1",
  name: "Recovery operations",
  teamId: "T123",
  signingCredentialName: "slack-signing",
  userMappings: [{ slackUserId: "U123", userId: "member-1" }],
  enabled: true,
  createdBy: "admin-1",
  createdAt: new Date("2026-07-21T00:00:00.000Z"),
  updatedAt: new Date("2026-07-21T00:00:00.000Z"),
};
const recoveryBefore = { id: "item-1", status: "open", owner: null };
const recoveryAfter = { id: "item-1", status: "acknowledged", owner: null };

function findRoute(method: string, path: string): Route {
  const route = slackInteractionsRoutes.find((entry) => {
    if (entry.method !== method) return false;
    return typeof entry.match === "string" ? entry.match === path : entry.match(path);
  });
  if (!route) throw new Error(`route not found: ${method} ${path}`);
  return route;
}

function buildCallback(actionId = "janusly_recovery_acknowledge") {
  const timestamp = Math.floor(Date.now() / 1000);
  const rawBody = new URLSearchParams({
    payload: JSON.stringify({
      type: "block_actions",
      team: { id: "T123" },
      user: { id: "U123" },
      actions: [{ action_id: actionId, value: "item-1" }],
    }),
  }).toString();
  const signature = `v0=${createHmac("sha256", secret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;
  return { rawBody, signature, timestamp };
}

async function callAdmin(method: string, path: string) {
  return findRoute(method, path).handler({ req: { url: path } as never, res: {} as never, auth });
}

async function callCallback(headers: Record<string, string>) {
  return findRoute("POST", "/webhooks/slack/interactions/connection-1").handler({
    req: { url: "/webhooks/slack/interactions/connection-1", headers } as never,
    res: {} as never,
    auth: {} as never,
  });
}

beforeEach(() => {
  vi.stubEnv("SLACK_SIGNING_SECRET", secret);
  dataMocks.getCallback.mockResolvedValue(connection);
  dataMocks.getCredential.mockResolvedValue({ kind: "slack_signing_secret", secretRef: "SLACK_SIGNING_SECRET" });
  dataMocks.hasSecret.mockResolvedValue(true);
  dataMocks.resolveSecret.mockResolvedValue(secret);
  dataMocks.resolveUser.mockReturnValue("member-1");
  dataMocks.apply.mockResolvedValue({ kind: "applied", before: recoveryBefore, after: recoveryAfter });
  vi.mocked(requireRole).mockResolvedValue("editor");
  vi.mocked(requirePermission).mockResolvedValue({ name: "editor", inheritsFrom: "editor" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("Slack interaction route gates", () => {
  it("keeps admin configuration behind credentials.write and callback auth internal", () => {
    expect(findRoute("GET", "/integrations/slack/interactions")).toMatchObject({
      role: "admin",
      permission: "credentials.write",
    });
    expect(findRoute("POST", "/integrations/slack/interactions")).toMatchObject({
      role: "admin",
      permission: "credentials.write",
    });
    expect(findRoute("POST", "/webhooks/slack/interactions/connection-1").skipAuth).toBe(true);
  });
});

describe("signed Slack callback", () => {
  it("verifies, authorizes, atomically applies, and audits an acknowledgement", async () => {
    const callback = buildCallback();
    httpMocks.readRawBody.mockResolvedValue(callback.rawBody);
    await callCallback({
      "x-slack-request-timestamp": String(callback.timestamp),
      "x-slack-signature": callback.signature,
    });

    expect(dataMocks.getCredential).toHaveBeenCalledWith("org-1", "slack_signing_secret", "slack-signing");
    expect(requireRole).toHaveBeenCalledWith("org-1", "member-1", "editor", "supabase");
    expect(requirePermission).toHaveBeenCalledWith("org-1", "member-1", "recovery.write", "supabase");
    expect(dataMocks.apply).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "org-1",
      connectionId: "connection-1",
      recoveryItemId: "item-1",
      userId: "member-1",
      action: "acknowledge",
      id: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(audit).toHaveBeenCalledWith(
      "org-1",
      "member-1",
      "recovery.item.acknowledged",
      "recovery-item",
      "item-1",
      expect.objectContaining({ source: "slack" }),
    );
    expect(httpMocks.sendJson.mock.calls.at(-1)?.[1]).toMatchObject({ ok: true });
  });

  it("rejects a bad signature before parsing, authorization, or mutation", async () => {
    httpMocks.readRawBody.mockResolvedValue("payload=%7B%7D");
    await callCallback({
      "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
      "x-slack-signature": `v0=${"0".repeat(64)}`,
    });

    expect(dataMocks.resolveUser).not.toHaveBeenCalled();
    expect(requirePermission).not.toHaveBeenCalled();
    expect(dataMocks.apply).not.toHaveBeenCalled();
    expect(httpMocks.sendJson.mock.calls.at(-1)?.[2]).toBe(401);
    expect(audit).not.toHaveBeenCalled();
  });

  it("does not attribute an unknown callback id to any tenant audit log", async () => {
    dataMocks.getCallback.mockResolvedValueOnce(null);
    await callCallback({});
    expect(httpMocks.sendJson.mock.calls.at(-1)?.[2]).toBe(404);
    expect(audit).not.toHaveBeenCalled();
    expect(dataMocks.apply).not.toHaveBeenCalled();
  });

  it("does not audit unsigned traffic to a disabled connection", async () => {
    dataMocks.getCallback.mockResolvedValueOnce({ ...connection, enabled: false });
    await callCallback({});

    expect(httpMocks.sendJson.mock.calls.at(-1)?.[2]).toBe(404);
    expect(dataMocks.getCredential).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(dataMocks.apply).not.toHaveBeenCalled();
  });

  it("rejects a signed callback from a different Slack team", async () => {
    const callback = buildCallback();
    const mismatched = callback.rawBody.replace("T123", "T999");
    const signature = `v0=${createHmac("sha256", secret)
      .update(`v0:${callback.timestamp}:${mismatched}`)
      .digest("hex")}`;
    httpMocks.readRawBody.mockResolvedValue(mismatched);
    await callCallback({
      "x-slack-request-timestamp": String(callback.timestamp),
      "x-slack-signature": signature,
    });

    expect(dataMocks.apply).not.toHaveBeenCalled();
    expect(httpMocks.sendJson.mock.calls.at(-1)?.[2]).toBe(403);
  });

  it("treats a repeated signed delivery as an idempotent success", async () => {
    const callback = buildCallback();
    httpMocks.readRawBody.mockResolvedValue(callback.rawBody);
    dataMocks.apply.mockResolvedValueOnce({ kind: "duplicate" });
    await callCallback({
      "x-slack-request-timestamp": String(callback.timestamp),
      "x-slack-signature": callback.signature,
    });
    expect(httpMocks.sendJson.mock.calls.at(-1)?.[1]).toEqual({ ok: true, duplicate: true });
    expect(audit).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "recovery.item.acknowledged",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("audits an open-link callback without mutating the recovery item", async () => {
    const callback = buildCallback("janusly_recovery_open");
    httpMocks.readRawBody.mockResolvedValue(callback.rawBody);
    await callCallback({
      "x-slack-request-timestamp": String(callback.timestamp),
      "x-slack-signature": callback.signature,
    });
    expect(dataMocks.apply).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      "org-1",
      "member-1",
      "slack.interaction.opened",
      "recovery-item",
      "item-1",
      expect.objectContaining({ source: "slack" }),
    );
  });
});

describe("Slack interaction admin projection", () => {
  it("lists tenant-scoped connections without exposing the credential secret ref", async () => {
    dataMocks.list.mockResolvedValueOnce([connection]);
    await callAdmin("GET", "/integrations/slack/interactions");
    expect(dataMocks.list).toHaveBeenCalledWith("org-1");
    const payload = httpMocks.sendJson.mock.calls.at(-1)?.[1];
    expect(payload).toMatchObject({ connections: [{ id: "connection-1", callbackUrl: "/webhooks/slack/interactions/connection-1" }] });
    expect(JSON.stringify(payload)).not.toContain("secretRef");
    expect(JSON.stringify(payload)).not.toContain("SLACK_SIGNING_SECRET");
  });

  it("validates credential kind and mapped member before create", async () => {
    httpMocks.readJson.mockResolvedValueOnce({
      name: "Recovery operations",
      teamId: "T123",
      signingCredentialName: "slack-signing",
      userMappings: [{ slackUserId: "U123", userId: "member-1" }],
      enabled: true,
    });
    dataMocks.getMember.mockResolvedValueOnce({ role: "editor" });
    dataMocks.create.mockResolvedValueOnce(connection);

    await callAdmin("POST", "/integrations/slack/interactions");
    expect(dataMocks.getCredential).toHaveBeenCalledWith("org-1", "slack_signing_secret", "slack-signing");
    expect(dataMocks.getMember).toHaveBeenCalledWith({ orgId: "org-1", userId: "member-1" });
    expect(dataMocks.create).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-1", createdBy: "admin-1" }));
    expect(auditAction).toHaveBeenCalledWith(auth, "slack.interaction.created", expect.anything());
    expect(httpMocks.sendJson.mock.calls.at(-1)?.[2]).toBe(201);
  });

  it("updates only an existing tenant connection and audits the safe delta", async () => {
    httpMocks.readJson.mockResolvedValueOnce({
      name: "Recovery operations updated",
      teamId: "T123",
      signingCredentialName: "slack-signing",
      userMappings: [{ slackUserId: "U123", userId: "member-1" }],
      enabled: false,
    });
    dataMocks.get.mockResolvedValueOnce(connection);
    dataMocks.getMember.mockResolvedValueOnce({ role: "editor" });
    dataMocks.update.mockResolvedValueOnce({
      ...connection,
      name: "Recovery operations updated",
      enabled: false,
    });

    await callAdmin("POST", "/integrations/slack/interactions/connection-1");

    expect(dataMocks.get).toHaveBeenCalledWith("org-1", "connection-1");
    expect(dataMocks.update).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "org-1",
      id: "connection-1",
      enabled: false,
    }));
    expect(auditAction).toHaveBeenCalledWith(auth, "slack.interaction.updated", expect.objectContaining({
      targetId: "connection-1",
      metadata: expect.objectContaining({
        before: expect.objectContaining({ enabled: true }),
        after: expect.objectContaining({ enabled: false }),
      }),
    }));
  });

  it("deletes through the tenant-scoped repository boundary", async () => {
    dataMocks.delete.mockResolvedValueOnce(connection);

    await callAdmin("DELETE", "/integrations/slack/interactions/connection-1");

    expect(dataMocks.delete).toHaveBeenCalledWith("org-1", "connection-1");
    expect(auditAction).toHaveBeenCalledWith(auth, "slack.interaction.deleted", expect.objectContaining({
      targetId: "connection-1",
    }));
    expect(httpMocks.sendJson.mock.calls.at(-1)?.[1]).toEqual({ ok: true });
  });
});

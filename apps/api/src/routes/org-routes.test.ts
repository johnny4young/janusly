/**
 * Tests for `/org/config` route-level memory consent orchestration.
 * Repo-level scheduler tests cover the BullMQ mechanics; this suite
 * pins the API ordering so audit readers see the consent transition
 * before/with the pending purge state.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@janusly/data/src/orgConfigRepo", () => ({
  getOrgConfigSnapshot: vi.fn(),
  listOrgConfig: vi.fn(),
  upsertOrgConfig: vi.fn(),
}));

vi.mock("@janusly/engine/src/memory-purge-scheduler", () => ({
  cancelPendingMemoryPurge: vi.fn(),
  schedulePendingMemoryPurge: vi.fn(),
}));

vi.mock("../audit", () => ({
  audit: vi.fn(),
}));

vi.mock("../http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../http")>();
  return {
    ...actual,
    readJson: vi.fn(),
    sendJson: vi.fn((_res: unknown, payload: unknown, status = 200) => ({ payload, status })),
  };
});

import { getOrgConfigSnapshot, upsertOrgConfig } from "@janusly/data/src/orgConfigRepo";
import {
  cancelPendingMemoryPurge,
  schedulePendingMemoryPurge,
} from "@janusly/engine/src/memory-purge-scheduler";

import { audit } from "../audit";
import { readJson, sendJson } from "../http";
import type { Route } from "../routes";
import { orgRoutes } from "./org-routes";

const getOrgConfigSnapshotMock = vi.mocked(getOrgConfigSnapshot);
const upsertOrgConfigMock = vi.mocked(upsertOrgConfig);
const cancelPendingMemoryPurgeMock = vi.mocked(cancelPendingMemoryPurge);
const schedulePendingMemoryPurgeMock = vi.mocked(schedulePendingMemoryPurge);
const auditMock = vi.mocked(audit);
const readJsonMock = vi.mocked(readJson);
const sendJsonMock = vi.mocked(sendJson);

const auth = {
  orgId: "org-1",
  userId: "user-1",
  mode: "dev-headers",
  source: "dev",
} as const;

function findConfigPostRoute(): Route {
  const route = orgRoutes.find((candidate) => {
    if (candidate.method !== "POST") return false;
    return typeof candidate.match === "string"
      ? candidate.match === "/org/config"
      : candidate.match("/org/config");
  });
  if (!route) throw new Error("route not found: POST /org/config");
  return route;
}

async function callConfig(body: Record<string, unknown>) {
  readJsonMock.mockResolvedValueOnce(body);
  const route = findConfigPostRoute();
  return route.handler({
    req: { url: "/org/config" } as never,
    res: {} as never,
    auth: auth as never,
  });
}

beforeEach(() => {
  getOrgConfigSnapshotMock.mockReset();
  upsertOrgConfigMock.mockReset();
  cancelPendingMemoryPurgeMock.mockReset();
  schedulePendingMemoryPurgeMock.mockReset();
  auditMock.mockReset();
  readJsonMock.mockReset();
  sendJsonMock.mockClear();
  upsertOrgConfigMock.mockImplementation(async ({ orgId, key, value, userId }) => ({
    orgId,
    key,
    value,
    updatedBy: userId,
    updatedAt: new Date("2026-05-21T00:00:00.000Z"),
  }) as never);
  auditMock.mockResolvedValue(undefined);
  cancelPendingMemoryPurgeMock.mockResolvedValue(false);
  schedulePendingMemoryPurgeMock.mockResolvedValue(true);
});

describe("POST /org/config memory consent", () => {
  it("awaits purge scheduling after the revoke audit on true to false", async () => {
    getOrgConfigSnapshotMock.mockResolvedValueOnce({ memory: { enabled: true } } as never);
    schedulePendingMemoryPurgeMock.mockResolvedValueOnce(true);

    const result = await callConfig({ key: "memory.enabled", value: false });

    expect(result).toMatchObject({
      status: 200,
      payload: { orgId: "org-1", key: "memory.enabled", value: false },
    });
    expect(auditMock).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "memory.consent.revoked",
      "org_config",
      "memory.enabled",
      { previousValue: true, newValue: false },
    );
    expect(schedulePendingMemoryPurgeMock).toHaveBeenCalledWith({ orgId: "org-1" });
    const revokeAuditOrder = auditMock.mock.invocationCallOrder[1];
    const scheduleOrder = schedulePendingMemoryPurgeMock.mock.invocationCallOrder[0];
    expect(revokeAuditOrder).toBeLessThan(scheduleOrder);
    expect(cancelPendingMemoryPurgeMock).not.toHaveBeenCalled();
  });

  it("cancels pending purge before the granted audit on false to true", async () => {
    getOrgConfigSnapshotMock.mockResolvedValueOnce({ memory: { enabled: false } } as never);
    cancelPendingMemoryPurgeMock.mockResolvedValueOnce(true);

    const result = await callConfig({ key: "memory.enabled", value: true });

    expect(result).toMatchObject({
      status: 200,
      payload: { orgId: "org-1", key: "memory.enabled", value: true },
    });
    expect(cancelPendingMemoryPurgeMock).toHaveBeenCalledWith({ orgId: "org-1" });
    expect(auditMock).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "memory.consent.granted",
      "org_config",
      "memory.enabled",
      { previousValue: false, newValue: true, pendingPurgeCancelled: true },
    );
    const cancelOrder = cancelPendingMemoryPurgeMock.mock.invocationCallOrder[0];
    const grantAuditOrder = auditMock.mock.invocationCallOrder[1];
    expect(cancelOrder).toBeLessThan(grantAuditOrder);
    expect(schedulePendingMemoryPurgeMock).not.toHaveBeenCalled();
  });
});

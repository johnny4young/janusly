/** Unit coverage for the tenant-scoped memory consent transparency route. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOrgConfigSnapshot: vi.fn(),
  getMemoryPurgeStatus: vi.fn(),
}));

vi.mock("@janusly/data/src/orgConfigRepo", () => ({
  getOrgConfigSnapshot: mocks.getOrgConfigSnapshot,
}));

vi.mock("@janusly/engine/src/memory-purge-scheduler", () => ({
  getMemoryPurgeStatus: mocks.getMemoryPurgeStatus,
}));

import { memoryRoutes } from "./memory-routes";

const auth = {
  orgId: "org-a",
  userId: "user-a",
  mode: "dev-headers",
  source: "dev",
} as const;

function fakeRes() {
  let body = "";
  return {
    statusCode: 200,
    setHeader: vi.fn(),
    getHeader: vi.fn(),
    writeHead(code: number) { this.statusCode = code; },
    write(payload: string) { body += payload; },
    end(payload?: string) { if (payload) body += payload; },
    read: () => JSON.parse(body),
  };
}

beforeEach(() => {
  mocks.getOrgConfigSnapshot.mockReset();
  mocks.getMemoryPurgeStatus.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /memory/consent-status", () => {
  it("declares viewer plus recovery-read access and a stable v1 contract", () => {
    expect(memoryRoutes[0]).toMatchObject({
      method: "GET",
      match: "/memory/consent-status",
      role: "viewer",
      permission: "recovery.read",
      contract: { operationId: "getMemoryConsentStatus" },
    });
  });

  it("returns effective consent plus the tenant purge schedule", async () => {
    vi.stubEnv("JANUSLY_MEMORY_ENABLED", "true");
    mocks.getOrgConfigSnapshot.mockResolvedValueOnce({ memory: { enabled: true } });
    mocks.getMemoryPurgeStatus.mockResolvedValueOnce({
      status: "scheduled",
      scheduledFor: "2026-07-21T12:00:00.000Z",
    });
    const res = fakeRes();

    await memoryRoutes[0]!.handler({ req: {} as never, res: res as never, auth });

    expect(mocks.getOrgConfigSnapshot).toHaveBeenCalledWith("org-a");
    expect(mocks.getMemoryPurgeStatus).toHaveBeenCalledWith({ orgId: "org-a" });
    expect(res.read()).toEqual({
      enabled: true,
      processEnabled: true,
      tenantEnabled: true,
      purge: { status: "scheduled", scheduledFor: "2026-07-21T12:00:00.000Z" },
    });
  });

  it("reports effective memory disabled when the process gate is off", async () => {
    vi.stubEnv("JANUSLY_MEMORY_ENABLED", "false");
    mocks.getOrgConfigSnapshot.mockResolvedValueOnce({ memory: { enabled: true } });
    mocks.getMemoryPurgeStatus.mockResolvedValueOnce({ status: "none", scheduledFor: null });
    const res = fakeRes();

    await memoryRoutes[0]!.handler({ req: {} as never, res: res as never, auth });

    expect(res.read()).toMatchObject({
      enabled: false,
      processEnabled: false,
      tenantEnabled: true,
    });
  });
});

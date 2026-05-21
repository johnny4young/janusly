import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getOrgConfigSnapshotMock } = vi.hoisted(() => ({
  getOrgConfigSnapshotMock: vi.fn(),
}));

vi.mock("./orgConfigRepo", () => ({
  getOrgConfigSnapshot: getOrgConfigSnapshotMock,
}));

import { isMemoryAllowed } from "./memoryConsent";

const ORIGINAL_MEMORY_ENABLED = process.env.JANUSLY_MEMORY_ENABLED;

beforeEach(() => {
  getOrgConfigSnapshotMock.mockReset();
  delete process.env.JANUSLY_MEMORY_ENABLED;
});

afterEach(() => {
  if (ORIGINAL_MEMORY_ENABLED === undefined) {
    delete process.env.JANUSLY_MEMORY_ENABLED;
  } else {
    process.env.JANUSLY_MEMORY_ENABLED = ORIGINAL_MEMORY_ENABLED;
  }
  vi.clearAllMocks();
});

describe("isMemoryAllowed", () => {
  it("fails closed when the process flag is disabled", async () => {
    const result = await isMemoryAllowed("default");
    expect(result).toEqual({
      allowed: false,
      reason: "process_disabled",
      message:
        "Memory is disabled at the process level (JANUSLY_MEMORY_ENABLED is not 'true').",
    });
    expect(getOrgConfigSnapshotMock).not.toHaveBeenCalled();
  });

  it("fails closed when tenant consent is disabled", async () => {
    process.env.JANUSLY_MEMORY_ENABLED = "true";
    getOrgConfigSnapshotMock.mockResolvedValueOnce({ memory: { enabled: false } });

    const result = await isMemoryAllowed("default");

    expect(result).toEqual({
      allowed: false,
      reason: "tenant_disabled",
      message:
        "Memory is not consented for this organization (memory.enabled is false).",
    });
  });

  it("fails closed instead of throwing when org config cannot be read", async () => {
    process.env.JANUSLY_MEMORY_ENABLED = "true";
    getOrgConfigSnapshotMock.mockRejectedValueOnce(new Error("db unavailable"));

    const result = await isMemoryAllowed("default");

    expect(result).toEqual({
      allowed: false,
      reason: "config_unavailable",
      message:
        "Memory consent could not be read for this organization; memory is disabled fail-closed.",
    });
  });

  it("allows memory only when both process and tenant flags are enabled", async () => {
    process.env.JANUSLY_MEMORY_ENABLED = "true";
    getOrgConfigSnapshotMock.mockResolvedValueOnce({ memory: { enabled: true } });

    await expect(isMemoryAllowed("default")).resolves.toEqual({ allowed: true });
  });
});

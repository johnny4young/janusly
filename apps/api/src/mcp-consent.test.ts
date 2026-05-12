import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@janusly/data/src/orgConfigRepo", () => ({
  getOrgConfigSnapshot: vi.fn(),
}));

import { getOrgConfigSnapshot } from "@janusly/data/src/orgConfigRepo";
import { isMcpWriteAllowed, mcpAuditMetadata, mcpRateLimitBucket } from "./mcp-consent";
import type { AuthContext } from "./auth";

const getOrgConfigSnapshotMock = vi.mocked(getOrgConfigSnapshot);

function snapshotWithConsent(consent: boolean) {
  return {
    ai: {} as never,
    http: {} as never,
    email: {} as never,
    runs: {} as never,
    mcp: { writeConsent: consent },
    integrations: {} as never,
  } as Awaited<ReturnType<typeof getOrgConfigSnapshot>>;
}

beforeEach(() => {
  getOrgConfigSnapshotMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isMcpWriteAllowed", () => {
  it("denies when the process env is off (default)", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "");
    const result = await isMcpWriteAllowed("org-a");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("process_disabled");
      expect(result.message).toMatch(/JANUSLY_MCP_WRITES_ENABLED/);
    }
    expect(getOrgConfigSnapshotMock).not.toHaveBeenCalled();
  });

  it("denies when the env is on but the tenant flag is off", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "true");
    getOrgConfigSnapshotMock.mockResolvedValueOnce(snapshotWithConsent(false));

    const result = await isMcpWriteAllowed("org-a");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("tenant_disabled");
      expect(result.message).toMatch(/mcp\.writeConsent/);
    }
    expect(getOrgConfigSnapshotMock).toHaveBeenCalledWith("org-a");
  });

  it("allows when both env and tenant flag are on", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "true");
    getOrgConfigSnapshotMock.mockResolvedValueOnce(snapshotWithConsent(true));

    const result = await isMcpWriteAllowed("org-a");
    expect(result.allowed).toBe(true);
  });

  it("treats any non-'true' env value as off (no truthy-string surprise)", async () => {
    for (const value of ["1", "yes", "TRUE", "on", " true "]) {
      vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", value);
      const result = await isMcpWriteAllowed("org-a");
      expect(result.allowed).toBe(false);
    }
  });

  it("uses the queried orgId for the snapshot lookup — no cross-tenant escape", async () => {
    vi.stubEnv("JANUSLY_MCP_WRITES_ENABLED", "true");
    getOrgConfigSnapshotMock.mockResolvedValueOnce(snapshotWithConsent(true));

    await isMcpWriteAllowed("org-b");
    expect(getOrgConfigSnapshotMock).toHaveBeenCalledWith("org-b");
  });
});

describe("mcpAuditMetadata", () => {
  it("tags source=mcp and carries the actor identifiers", () => {
    const auth: AuthContext = {
      orgId: "org-a",
      userId: "mcp-user",
      mode: "service-token",
      source: "mcp",
      serviceTokenSuffix: "abcd",
    };
    expect(mcpAuditMetadata(auth)).toEqual({
      source: "mcp",
      actor: {
        userId: "mcp-user",
        mode: "service-token",
        serviceTokenSuffix: "abcd",
      },
    });
  });

  it("never includes the full service token — only the trailing 4 chars", () => {
    const auth: AuthContext = {
      orgId: "org-a",
      userId: "mcp-user",
      mode: "service-token",
      source: "mcp",
      serviceTokenSuffix: "wxyz",
    };
    const metadata = mcpAuditMetadata(auth) as { actor: { serviceTokenSuffix?: string } };
    expect(metadata.actor.serviceTokenSuffix).toBe("wxyz");
    expect(metadata.actor.serviceTokenSuffix?.length).toBeLessThanOrEqual(4);
  });
});

describe("mcpRateLimitBucket", () => {
  it("composes a stable bucket name from the action key", () => {
    expect(mcpRateLimitBucket("workflows.save")).toBe("mcp.workflows.save");
    expect(mcpRateLimitBucket("workflows.run")).toBe("mcp.workflows.run");
  });
});

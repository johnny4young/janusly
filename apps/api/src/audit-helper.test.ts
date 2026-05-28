import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the lower-level chokepoint so we can assert exactly what the helper
// forwards. The real `audit()` swallows write failures; the helper adds no
// new throw surface on top of it.
const auditMock = vi.fn();
vi.mock("./audit", () => ({ audit: (...args: unknown[]) => auditMock(...args) }));

import { auditAction, type AuditAction } from "./audit-helper";
import type { AuthContext } from "./auth";

const auth: AuthContext = {
  orgId: "org-1",
  userId: "user-1",
  mode: "supabase",
  source: "web",
  serviceTokenSuffix: undefined,
};

beforeEach(() => {
  auditMock.mockReset();
  auditMock.mockResolvedValue(undefined);
});

describe("auditAction", () => {
  it("forwards orgId/userId/action/target and injects actor + source", async () => {
    await auditAction(auth, "member.removed", {
      targetType: "member",
      targetId: "u-9",
      metadata: { role: "viewer" },
    });
    expect(auditMock).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "member.removed",
      "member",
      "u-9",
      expect.objectContaining({
        role: "viewer",
        source: "web",
        actor: { userId: "user-1", mode: "supabase", serviceTokenSuffix: undefined },
      }),
    );
  });

  it("defaults to an actor/source-only payload when options are omitted", async () => {
    await auditAction(auth, "auto_healing.scan.triggered");
    expect(auditMock).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "auto_healing.scan.triggered",
      undefined,
      undefined,
      expect.objectContaining({
        source: "web",
        actor: expect.objectContaining({ userId: "user-1" }),
      }),
    );
  });

  it("lets the derived actor/source win over caller-supplied collisions", async () => {
    await auditAction(auth, "workflow.saved", {
      metadata: { source: "spoofed", actor: { userId: "evil" } },
    });
    const metadata = auditMock.mock.calls[0]![5] as { source: string; actor: { userId: string } };
    expect(metadata.source).toBe("web");
    expect(metadata.actor.userId).toBe("user-1");
  });

  it("carries serviceTokenSuffix into actor for service-token callers", async () => {
    const serviceAuth: AuthContext = {
      ...auth,
      mode: "service-token",
      source: "service",
      serviceTokenSuffix: "ab12",
    };
    await auditAction(serviceAuth, "workflow.saved", { targetType: "workflow", targetId: "wf-1" });
    const metadata = auditMock.mock.calls[0]![5] as { actor: { serviceTokenSuffix?: string } };
    expect(metadata.actor.serviceTokenSuffix).toBe("ab12");
  });

  it("resolves without throwing on a normal call (delegates to the never-throw audit sink)", async () => {
    await expect(
      auditAction(auth, "dlq.resolved", { targetType: "dlq", targetId: "d-1" }),
    ).resolves.toBeUndefined();
  });

  it("rejects an unknown action name at compile time", () => {
    // @ts-expect-error — "bogus.action" is not a member of the closed AuditAction catalog.
    const bogus: AuditAction = "bogus.action";
    void bogus;
  });
});

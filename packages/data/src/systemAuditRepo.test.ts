/**
 * Contract tests for the system-audit chokepoint: defaults, redaction cap
 * plumbing, and the never-throw posture the callers (schedulers, pollers,
 * the alert dispatcher) rely on.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { insertMock, valuesMock } = vi.hoisted(() => {
  const valuesMock = vi.fn(async () => undefined);
  return { insertMock: vi.fn(() => ({ values: valuesMock })), valuesMock };
});

vi.mock("@janusly/db", () => ({ db: { insert: insertMock }, auditLogs: {} }));

import { recordSystemAudit, SYSTEM_AUDIT_METADATA_MAX_BYTES } from "./systemAuditRepo";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("recordSystemAudit", () => {
  it("writes an unattributed system row by default", async () => {
    await recordSystemAudit({ orgId: "system", action: "retention.purged" });

    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "system",
      userId: null,
      action: "retention.purged",
      targetType: null,
      targetId: null,
    }));
  });

  it("carries a named system actor when given", async () => {
    await recordSystemAudit({ orgId: "org-1", action: "upstream.source.paused", actor: "system:upstream-health" });

    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({ userId: "system:upstream-health" }));
  });

  it("redacts secret-shaped metadata keys — the chokepoint is the point", async () => {
    // Two schedulers used to write RAW metadata; this is the regression
    // guard that routing them here actually buys the redaction.
    await recordSystemAudit({
      orgId: "org-1",
      action: "retention.purged",
      metadata: { apiKey: "sk-live-123", rows: 4 },
    });

    const row = valuesMock.mock.calls.at(-1)?.[0] as { metadata: Record<string, unknown> };
    expect(row.metadata.rows).toBe(4);
    expect(row.metadata.apiKey).not.toBe("sk-live-123");
  });

  it("caps oversized metadata with the truncation sentinel", async () => {
    await recordSystemAudit({
      orgId: "org-1",
      action: "x",
      metadata: { blob: "a".repeat(SYSTEM_AUDIT_METADATA_MAX_BYTES + 1024) },
    });

    const row = valuesMock.mock.calls.at(-1)?.[0] as { metadata: Record<string, unknown> };
    expect(row.metadata.__truncated).toBe(true);
  });

  it("honours a caller-specific smaller cap (the dispatcher's 64 KB)", async () => {
    await recordSystemAudit({
      orgId: "org-1",
      action: "x",
      metadata: { blob: "a".repeat(100_000) },
      maxBytes: 64_000,
    });

    const row = valuesMock.mock.calls.at(-1)?.[0] as { metadata: Record<string, unknown> };
    expect(row.metadata.__truncated).toBe(true);
  });

  it("NEVER throws — a failed audit insert must not break the sweep that called it", async () => {
    valuesMock.mockRejectedValueOnce(new Error("pg down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(recordSystemAudit({ orgId: "system", action: "x", logTag: "[reaper]" }))
      .resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith("[reaper] audit write failed", expect.anything());
    warn.mockRestore();
  });
});

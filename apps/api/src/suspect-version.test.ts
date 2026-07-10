/**
 * Tests for the M-08 suspect-version correlation: the pure window check and
 * the resolver's miss/hit paths (orphaned run, cross-org run, v1, stale save,
 * pruned predecessor, and the happy envelope with both DAG snapshots).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { limitMock } = vi.hoisted(() => ({ limitMock: vi.fn() }));

vi.mock("@janusly/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: limitMock })),
      })),
    })),
  },
  runs: { id: "id", orgId: "org_id", workflowVersionId: "workflow_version_id" },
  workflowVersions: { id: "id", orgId: "org_id", workflowId: "workflow_id", version: "version", createdAt: "created_at" },
}));

import {
  SUSPECT_VERSION_WINDOW_MS,
  isWithinSuspectWindow,
  resolveSuspectVersion,
} from "./suspect-version";

const SAVE = new Date("2026-07-10T10:00:00.000Z");

function minutesAfterSave(minutes: number): Date {
  return new Date(SAVE.getTime() + minutes * 60_000);
}

describe("isWithinSuspectWindow", () => {
  it("accepts a failure at the save instant and at the window edge", () => {
    expect(isWithinSuspectWindow(SAVE, SAVE)).toBe(true);
    expect(isWithinSuspectWindow(SAVE, new Date(SAVE.getTime() + SUSPECT_VERSION_WINDOW_MS))).toBe(true);
  });

  it("rejects a failure past the window or BEFORE the save", () => {
    expect(isWithinSuspectWindow(SAVE, new Date(SAVE.getTime() + SUSPECT_VERSION_WINDOW_MS + 1))).toBe(false);
    // A failure that predates the save can never be attributed to it.
    expect(isWithinSuspectWindow(SAVE, new Date(SAVE.getTime() - 1))).toBe(false);
  });

  it("honours a custom window", () => {
    expect(isWithinSuspectWindow(SAVE, minutesAfterSave(10), 5 * 60_000)).toBe(false);
    expect(isWithinSuspectWindow(SAVE, minutesAfterSave(4), 5 * 60_000)).toBe(true);
  });
});

describe("resolveSuspectVersion", () => {
  beforeEach(() => {
    limitMock.mockReset();
  });

  const RUN = { workflowVersionId: "wfv-2", orgId: "org-1" };
  const VERSION = { id: "wfv-2", orgId: "org-1", workflowId: "wf-1", version: 2, createdAt: SAVE, dagJson: { id: "wf-1", nodes: [{ id: "b" }] } };
  const PREVIOUS = { id: "wfv-1", orgId: "org-1", workflowId: "wf-1", version: 1, createdAt: new Date("2026-07-01T00:00:00.000Z"), dagJson: { id: "wf-1", nodes: [{ id: "a" }] } };

  it("returns the envelope with both snapshots on the happy path", async () => {
    limitMock
      .mockResolvedValueOnce([RUN])
      .mockResolvedValueOnce([VERSION])
      .mockResolvedValueOnce([PREVIOUS]);

    const result = await resolveSuspectVersion("org-1", "run-1", minutesAfterSave(30));
    expect(result).toEqual({
      workflowId: "wf-1",
      version: 2,
      versionId: "wfv-2",
      savedAt: SAVE.toISOString(),
      previousVersion: 1,
      previousVersionId: "wfv-1",
      dagJson: VERSION.dagJson,
      previousDagJson: PREVIOUS.dagJson,
    });
  });

  it("returns null without querying when the failure has no timestamp", async () => {
    expect(await resolveSuspectVersion("org-1", "run-1", null)).toBeNull();
    expect(limitMock).not.toHaveBeenCalled();
  });

  it("returns null for an orphaned run (no FK by design)", async () => {
    limitMock.mockResolvedValueOnce([]);
    expect(await resolveSuspectVersion("org-1", "run-1", minutesAfterSave(30))).toBeNull();
  });

  it("returns null for a cross-org run", async () => {
    limitMock.mockResolvedValueOnce([{ ...RUN, orgId: "org-2" }]);
    expect(await resolveSuspectVersion("org-1", "run-1", minutesAfterSave(30))).toBeNull();
  });

  it("returns null for v1 (no predecessor to diff against)", async () => {
    limitMock
      .mockResolvedValueOnce([RUN])
      .mockResolvedValueOnce([{ ...VERSION, version: 1 }]);
    expect(await resolveSuspectVersion("org-1", "run-1", minutesAfterSave(30))).toBeNull();
  });

  it("returns null when the failure lands outside the window", async () => {
    limitMock
      .mockResolvedValueOnce([RUN])
      .mockResolvedValueOnce([VERSION]);
    const past = new Date(SAVE.getTime() + SUSPECT_VERSION_WINDOW_MS + 60_000);
    expect(await resolveSuspectVersion("org-1", "run-1", past)).toBeNull();
  });

  it("returns null when the predecessor row is gone (retention prune)", async () => {
    limitMock
      .mockResolvedValueOnce([RUN])
      .mockResolvedValueOnce([VERSION])
      .mockResolvedValueOnce([]);
    expect(await resolveSuspectVersion("org-1", "run-1", minutesAfterSave(30))).toBeNull();
  });
});

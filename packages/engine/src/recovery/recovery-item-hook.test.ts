import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createRecoveryItemMock: vi.fn(),
  getRecoveryItemSeverityDefaultMock: vi.fn(),
  recordAlertEventMock: vi.fn(),
  getOrgConfigSnapshotMock: vi.fn(),
  auditInsertMock: vi.fn(),
}));

vi.mock("@janusly/db", () => ({
  db: {
    insert: vi.fn(() => ({
      values: mocks.auditInsertMock,
    })),
  },
  auditLogs: { id: "id_col" },
}));

vi.mock("@janusly/data/src/orgConfigRepo", () => ({
  getOrgConfigSnapshot: mocks.getOrgConfigSnapshotMock,
}));

vi.mock("@janusly/data/src/recoveryItemsRepo", () => ({
  createRecoveryItem: mocks.createRecoveryItemMock,
  getRecoveryItemByDeadLetterId: vi.fn(),
  resolveRecoveryItem: vi.fn(),
}));

vi.mock("@janusly/data/src/alert-dispatch", () => ({
  recordAlertEvent: mocks.recordAlertEventMock,
}));

vi.mock("@janusly/data/src/recovery-item-severity-default", () => ({
  getRecoveryItemSeverityDefault: mocks.getRecoveryItemSeverityDefaultMock,
}));

import { createRecoveryItemForDeadLetter } from "./recovery-item-hook";

const {
  createRecoveryItemMock,
  getRecoveryItemSeverityDefaultMock,
  recordAlertEventMock,
  getOrgConfigSnapshotMock,
  auditInsertMock,
} = mocks;

beforeEach(() => {
  vi.clearAllMocks();
  getOrgConfigSnapshotMock.mockResolvedValue({ recovery: { autoCreateItems: true } });
  auditInsertMock.mockResolvedValue(undefined);
  recordAlertEventMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

function mockCreateRecoveryItemReturning(severity: string) {
  createRecoveryItemMock.mockResolvedValueOnce({
    wasCreated: true,
    item: {
      id: "ri_1",
      severity,
      slaTargetAt: new Date("2026-05-23T05:00:00Z"),
    },
  });
}

describe("createRecoveryItemForDeadLetter — severity default integration", () => {
  it("passes severityDefault from the resolver into createRecoveryItem", async () => {
    getRecoveryItemSeverityDefaultMock.mockResolvedValueOnce("p1");
    mockCreateRecoveryItemReturning("p1");

    await createRecoveryItemForDeadLetter({
      orgId: "default",
      deadLetterId: "dl_1",
      createdBy: "system",
      workflowId: "wf_1",
    });

    expect(getRecoveryItemSeverityDefaultMock).toHaveBeenCalledWith("default", "wf_1");
    expect(createRecoveryItemMock).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "p1", workflowId: "wf_1" }),
    );
  });

  it("omits the severity field when the resolver returns null (falls back to repo default 'p3')", async () => {
    getRecoveryItemSeverityDefaultMock.mockResolvedValueOnce(null);
    mockCreateRecoveryItemReturning("p3");

    await createRecoveryItemForDeadLetter({
      orgId: "default",
      deadLetterId: "dl_2",
      createdBy: "system",
      workflowId: "wf_2",
    });

    expect(createRecoveryItemMock).toHaveBeenCalledTimes(1);
    const callArg = createRecoveryItemMock.mock.calls[0][0];
    expect(callArg.severity).toBeUndefined();
  });

  it("skips the resolver when workflowId is null (ad-hoc workflow)", async () => {
    mockCreateRecoveryItemReturning("p3");

    await createRecoveryItemForDeadLetter({
      orgId: "default",
      deadLetterId: "dl_3",
      createdBy: "system",
      workflowId: null,
    });

    expect(getRecoveryItemSeverityDefaultMock).not.toHaveBeenCalled();
    const callArg = createRecoveryItemMock.mock.calls[0][0];
    expect(callArg.severity).toBeUndefined();
  });
});

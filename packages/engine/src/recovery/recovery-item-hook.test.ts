import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createRecoveryItemMock: vi.fn(),
  getRecoveryItemSeverityDefaultMock: vi.fn(),
  recordAlertEventMock: vi.fn(),
  getOrgConfigSnapshotMock: vi.fn(),
  auditInsertMock: vi.fn(),
  findOpenForDebounceMock: vi.fn(),
  attachMock: vi.fn(),
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
  findOpenRecoveryItemForDebounce: mocks.findOpenForDebounceMock,
  attachDeadLetterToRecoveryItem: mocks.attachMock,
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
  findOpenForDebounceMock,
  attachMock,
} = mocks;

beforeEach(() => {
  vi.clearAllMocks();
  // Debounce off by default so the severity-default suite below exercises
  // the create path unchanged.
  getOrgConfigSnapshotMock.mockResolvedValue({
    recovery: { autoCreateItems: true, debounceWindowSeconds: 0 },
  });
  auditInsertMock.mockResolvedValue(undefined);
  recordAlertEventMock.mockResolvedValue(undefined);
  findOpenForDebounceMock.mockResolvedValue(null);
  attachMock.mockResolvedValue({ occurrenceCount: 2 });
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

describe("createRecoveryItemForDeadLetter — debounce", () => {
  function enableDebounce(windowSeconds: number) {
    getOrgConfigSnapshotMock.mockResolvedValue({
      recovery: { autoCreateItems: true, debounceWindowSeconds: windowSeconds },
    });
  }

  it("creates a new item (never debounces) when the window is 0", async () => {
    enableDebounce(0);
    getRecoveryItemSeverityDefaultMock.mockResolvedValueOnce(null);
    mockCreateRecoveryItemReturning("p3");

    await createRecoveryItemForDeadLetter({
      orgId: "default",
      deadLetterId: "dl_a",
      createdBy: "system",
      workflowId: "wf_1",
      errorSignature: "HTTP 500 on http node",
    });

    expect(findOpenForDebounceMock).not.toHaveBeenCalled();
    expect(createRecoveryItemMock).toHaveBeenCalledTimes(1);
  });

  it("attaches to a recent matching parent instead of creating, and fires NO created-alert", async () => {
    enableDebounce(300);
    findOpenForDebounceMock.mockResolvedValueOnce({ id: "ri_parent", deadLetterId: "dl_first" });
    attachMock.mockResolvedValueOnce({ occurrenceCount: 5 });

    await createRecoveryItemForDeadLetter({
      orgId: "default",
      deadLetterId: "dl_new",
      createdBy: "system",
      workflowId: "wf_1",
      errorSignature: "HTTP 500 on http node",
    });

    expect(attachMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "default", recoveryItemId: "ri_parent", deadLetterId: "dl_new" }),
    );
    expect(createRecoveryItemMock).not.toHaveBeenCalled();
    expect(recordAlertEventMock).not.toHaveBeenCalled();
    expect(auditInsertMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "recovery.item.occurrence_attached" }),
    );
  });

  it("creates a new item when no open parent is within the window, persisting the signature", async () => {
    enableDebounce(300);
    findOpenForDebounceMock.mockResolvedValueOnce(null);
    getRecoveryItemSeverityDefaultMock.mockResolvedValueOnce(null);
    mockCreateRecoveryItemReturning("p3");

    await createRecoveryItemForDeadLetter({
      orgId: "default",
      deadLetterId: "dl_b",
      createdBy: "system",
      workflowId: "wf_1",
      errorSignature: "HTTP 500 on http node",
    });

    expect(attachMock).not.toHaveBeenCalled();
    expect(createRecoveryItemMock).toHaveBeenCalledWith(
      expect.objectContaining({ errorSignature: "HTTP 500 on http node" }),
    );
  });

  it("skips debounce (creates) when the failure has no signature to group on", async () => {
    enableDebounce(300);
    getRecoveryItemSeverityDefaultMock.mockResolvedValueOnce(null);
    mockCreateRecoveryItemReturning("p3");

    await createRecoveryItemForDeadLetter({
      orgId: "default",
      deadLetterId: "dl_c",
      createdBy: "system",
      workflowId: "wf_1",
      // no errorSignature
    });

    expect(findOpenForDebounceMock).not.toHaveBeenCalled();
    expect(createRecoveryItemMock).toHaveBeenCalledTimes(1);
  });

  it("does not self-attach when the matched parent is this very DLQ row", async () => {
    enableDebounce(300);
    findOpenForDebounceMock.mockResolvedValueOnce({ id: "ri_self", deadLetterId: "dl_same" });

    await createRecoveryItemForDeadLetter({
      orgId: "default",
      deadLetterId: "dl_same",
      createdBy: "system",
      workflowId: "wf_1",
      errorSignature: "HTTP 500 on http node",
    });

    expect(attachMock).not.toHaveBeenCalled();
    expect(createRecoveryItemMock).not.toHaveBeenCalled();
  });

  it("never throws when the debounce lookup fails (best-effort telemetry)", async () => {
    enableDebounce(300);
    findOpenForDebounceMock.mockRejectedValueOnce(new Error("db down"));

    await expect(
      createRecoveryItemForDeadLetter({
        orgId: "default",
        deadLetterId: "dl_d",
        createdBy: "system",
        workflowId: "wf_1",
        errorSignature: "HTTP 500 on http node",
      }),
    ).resolves.toBeUndefined();
    expect(createRecoveryItemMock).not.toHaveBeenCalled();
  });
});

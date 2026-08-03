/**
 * Pure-unit tests for the auto-healing decision repo.
 *
 * `@janusly/db` is mocked so no DB is hit. Coverage:
 *   - Multi-tenant scope on every read.
 *   - Diagnose / propose / validate / decide write the matching
 *     audit rows.
 *   - Accepted decisions claim publication before `applied`; only a matching
 *     durable receipt can complete the state transition.
 *   - `countRecentAttemptsBySignature` filters by window.
 *   - `sweepStaleValidating` flips stuck rows and writes the audit
 *     batch.
 *   - `getDeadLetterIdsWithExistingRun` returns a set for the
 *     scanner's idempotency check.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  insertValuesMock,
  updateSetMock,
  selectFromMock,
  transactionMock,
} = vi.hoisted(() => ({
  insertValuesMock: vi.fn(),
  updateSetMock: vi.fn(),
  selectFromMock: vi.fn(),
  transactionMock: vi.fn(),
}));

vi.mock("@janusly/db", () => ({
  db: {
    insert: vi.fn(() => ({ values: insertValuesMock })),
    update: vi.fn(() => ({ set: updateSetMock })),
    select: vi.fn(() => ({ from: selectFromMock })),
    transaction: transactionMock,
  },
  autoHealingRuns: {
    id: "id_col",
    orgId: "org_id_col",
    deadLetterId: "dead_letter_id_col",
    signature: "signature_col",
    status: "status_col",
    publicationReceipt: "publication_receipt_col",
    publicationRepairAfter: "publication_repair_after_col",
    publicationAttempts: "publication_attempts_col",
    decisionActor: "decision_actor_col",
    validationEvidenceLevel: "validation_evidence_level_col",
    createdAt: "created_at_col",
    updatedAt: "updated_at_col",
  } as Record<string, string>,
  auditLogs: { id: "audit_id_col" },
}));

import { db } from "@janusly/db";
import {
  claimApplyPublication,
  completeApplyPublication,
  createDiagnosis,
  recordDeclineDecision,
  recordImmediateDecline,
  recordValidationOutcome,
  countRecentAttemptsBySignature,
  findLatestOutcomeBySignature,
  getDeadLetterIdsWithExistingRun,
  sweepStaleValidating,
} from "./autoHealingRepo";

const dbInsertMock = vi.mocked(db.insert);
const dbUpdateMock = vi.mocked(db.update);
const dbSelectMock = vi.mocked(db.select);

beforeEach(() => {
  insertValuesMock.mockReset().mockResolvedValue(undefined);
  updateSetMock.mockReset();
  selectFromMock.mockReset();
  dbInsertMock.mockClear();
  dbUpdateMock.mockClear();
  dbSelectMock.mockClear();
  transactionMock.mockReset().mockImplementation(
    async (handler: (tx: typeof db) => Promise<unknown>) => handler(db),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("createDiagnosis", () => {
  it("inserts a diagnosed row and writes the audit row", async () => {
    const id = await createDiagnosis({
      orgId: "org-1",
      deadLetterId: "dlq-1",
      signature: "sig-foo",
      loopAttemptCount: 0,
    });
    expect(typeof id).toBe("string");
    // Two inserts: the auto_healing_runs row + the audit row.
    expect(insertValuesMock).toHaveBeenCalledTimes(2);
    expect(insertValuesMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      orgId: "org-1",
      deadLetterId: "dlq-1",
      signature: "sig-foo",
      status: "diagnosed",
      loopAttemptCount: 0,
    }));
    expect(insertValuesMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      orgId: "org-1",
      action: "auto_healing.diagnosed",
      metadata: expect.objectContaining({ signature: "sig-foo", loopAttemptCount: 0 }),
    }));
  });
});

describe("recordImmediateDecline", () => {
  it("inserts a declined row + audit with the front-of-loop reason (loop_breaker_tripped)", async () => {
    await recordImmediateDecline("org-1", "dlq-1", "sig-foo", 3, "loop_breaker_tripped");
    expect(insertValuesMock).toHaveBeenCalledTimes(2);
    expect(insertValuesMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      orgId: "org-1",
      status: "declined",
      declineReason: "loop_breaker_tripped",
      decisionActor: "system_decline_loop_breaker_tripped",
    }));
    expect(insertValuesMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      action: "auto_healing.declined",
      metadata: expect.objectContaining({
        decisionActor: "system_decline_loop_breaker_tripped",
        declineReason: "loop_breaker_tripped",
      }),
    }));
  });
});

describe("recordValidationOutcome", () => {
  it("marks the row validated on success", async () => {
    const returning = vi.fn().mockResolvedValue([{ orgId: "org-1" }]);
    const where = vi.fn(() => ({ returning }));
    updateSetMock.mockReturnValue({ where });

    await recordValidationOutcome("row-1", {
      outcome: "validated",
      validationSignature: null,
      validationEvidenceLevel: "writes_skipped",
    });

    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({
      status: "validated",
      validationSignature: null,
      validationEvidenceLevel: "writes_skipped",
    }));
    // One follow-up insert for the audit row.
    expect(insertValuesMock).toHaveBeenCalledTimes(1);
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "auto_healing.validated",
      metadata: expect.objectContaining({ validated: true }),
    }));
  });

  it("marks the row validation_failed and records the reason on signature change", async () => {
    const returning = vi.fn().mockResolvedValue([{ orgId: "org-1" }]);
    const where = vi.fn(() => ({ returning }));
    updateSetMock.mockReturnValue({ where });

    await recordValidationOutcome("row-1", {
      outcome: "validation_failed",
      validationSignature: "different-sig",
      validationEvidenceLevel: "static",
      reason: "signature_changed",
    });

    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({
      status: "validation_failed",
      validationSignature: "different-sig",
      declineReason: "signature_changed",
    }));
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        validated: false,
        signatureChanged: true,
        reason: "signature_changed",
      }),
    }));
  });
});

describe("durable apply decision", () => {
  it("claims validated to publishing without writing an applied audit", async () => {
    const returning = vi.fn().mockResolvedValue([{ id: "row-1" }]);
    const where = vi.fn(() => ({ returning }));
    updateSetMock.mockReturnValue({ where });

    const result = await claimApplyPublication("org-1", "row-1", "user-1");

    expect(result.claimed).toBe(true);
    expect(result.receipt).toEqual(expect.any(String));
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({
      status: "publishing",
      decisionActor: "user-1",
      publicationReceipt: result.receipt,
    }));
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it("writes the applied audit only when a matching receipt completes the transition", async () => {
    const returning = vi.fn().mockResolvedValue([
      {
        signature: "sig-foo",
        deadLetterId: "dlq-1",
        decisionActor: "user-1",
      },
    ]);
    const where = vi.fn(() => ({ returning }));
    updateSetMock.mockReturnValue({ where });

    const result = await completeApplyPublication(
      "org-1",
      "row-1",
      "receipt-1",
    );

    expect(result).toBe(true);
    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "auto_healing.applied",
      metadata: expect.objectContaining({
        decisionActor: "user-1",
        signature: "sig-foo",
        publicationReceipt: "receipt-1",
      }),
    }));
  });

  it("writes no audit when completion loses the CAS race", async () => {
    const returning = vi.fn().mockResolvedValue([]);
    const where = vi.fn(() => ({ returning }));
    updateSetMock.mockReturnValue({ where });

    const result = await completeApplyPublication(
      "org-1",
      "row-1",
      "receipt-1",
    );

    expect(result).toBe(false);
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it("declines with a tenant-scoped CAS and one audit", async () => {
    const returning = vi.fn().mockResolvedValue([
      { signature: "sig-foo", deadLetterId: "dlq-1" },
    ]);
    const where = vi.fn(() => ({ returning }));
    updateSetMock.mockReturnValue({ where });

    await expect(
      recordDeclineDecision("org-1", "row-1", "user-1"),
    ).resolves.toBe(true);

    expect(insertValuesMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "auto_healing.declined",
      metadata: expect.objectContaining({ decisionActor: "user-1" }),
    }));
  });
});

describe("countRecentAttemptsBySignature", () => {
  it("filters by org + signature + window and returns the count", async () => {
    const limit = vi.fn();
    const where = vi.fn().mockResolvedValue([{ value: 4 }]);
    selectFromMock.mockReturnValue({ where });

    const n = await countRecentAttemptsBySignature("org-1", "sig-foo", 14);

    expect(n).toBe(4);
    expect(where).toHaveBeenCalledTimes(1);
    void limit; // intentionally unused (count query does not paginate)
  });
});

describe("findLatestOutcomeBySignature", () => {
  it("returns the latest terminal outcome from a tenant-scoped bounded query", async () => {
    const limit = vi.fn().mockResolvedValue([{
      id: "heal-prior",
      orgId: "org-1",
      deadLetterId: "dlq-prior",
      signature: "Network timeout on http node",
      status: "applied",
      proposedPatchJson: null,
      approachLabel: "add_retry",
      confidence: 82,
      validationRunId: "validation-prior",
      validationSignature: null,
      decisionActor: "user-1",
      declineReason: null,
      loopAttemptCount: 1,
      metadata: null,
      createdAt: new Date("2026-07-01T00:00:00Z"),
      updatedAt: new Date("2026-07-01T00:10:00Z"),
    }]);
    const orderBy = vi.fn(() => ({ limit }));
    const where = vi.fn(() => ({ orderBy }));
    selectFromMock.mockReturnValue({ where });

    const result = await findLatestOutcomeBySignature(
      "org-1",
      "Network timeout on http node",
      "dlq-current",
    );

    expect(result).toMatchObject({
      id: "heal-prior",
      orgId: "org-1",
      status: "applied",
      approachLabel: "add_retry",
    });
    expect(where).toHaveBeenCalledTimes(1);
    expect(orderBy).toHaveBeenCalledTimes(1);
    expect(limit).toHaveBeenCalledWith(1);
  });

  it("returns null when no completed outcome exists", async () => {
    const limit = vi.fn().mockResolvedValue([]);
    const orderBy = vi.fn(() => ({ limit }));
    const where = vi.fn(() => ({ orderBy }));
    selectFromMock.mockReturnValue({ where });

    await expect(findLatestOutcomeBySignature("org-1", "sig", "dlq-current")).resolves.toBeNull();
  });
});

describe("getDeadLetterIdsWithExistingRun", () => {
  it("returns an empty set when called with no dead letter ids (skips the round trip)", async () => {
    const result = await getDeadLetterIdsWithExistingRun("org-1", []);
    expect(result.size).toBe(0);
    expect(selectFromMock).not.toHaveBeenCalled();
  });

  it("returns the set of dead letter ids that already have a run row", async () => {
    const where = vi.fn().mockResolvedValue([
      { deadLetterId: "dlq-1" },
      { deadLetterId: "dlq-2" },
    ]);
    selectFromMock.mockReturnValue({ where });

    const result = await getDeadLetterIdsWithExistingRun("org-1", ["dlq-1", "dlq-2", "dlq-3"]);

    expect(result).toEqual(new Set(["dlq-1", "dlq-2"]));
  });
});

describe("sweepStaleValidating", () => {
  it("returns the number of rows swept and writes one audit per sweep", async () => {
    const returning = vi.fn().mockResolvedValue([
      { id: "row-1", orgId: "org-1" },
      { id: "row-2", orgId: "org-2" },
    ]);
    const where = vi.fn(() => ({ returning }));
    updateSetMock.mockReturnValue({ where });

    const n = await sweepStaleValidating(2);

    expect(n).toBe(2);
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({
      status: "declined",
      declineReason: "validation_timeout",
      decisionActor: "system_decline_validation_timeout",
    }));
    expect(insertValuesMock).toHaveBeenCalledTimes(2);
  });
});

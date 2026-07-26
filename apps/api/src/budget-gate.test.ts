import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  auditMock,
  checkBudgetMock,
  dbSelectMock,
} = vi.hoisted(() => ({
  auditMock: vi.fn(),
  checkBudgetMock: vi.fn(),
  dbSelectMock: vi.fn(),
}));

vi.mock("./audit", () => ({ audit: auditMock }));

vi.mock("@janusly/engine/src/budget", () => ({
  checkBudget: checkBudgetMock,
}));

vi.mock("@janusly/db", () => ({
  db: { select: dbSelectMock },
  auditLogs: {
    id: "audit_logs.id",
    orgId: "audit_logs.org_id",
    action: "audit_logs.action",
    metadata: "audit_logs.metadata",
    createdAt: "audit_logs.created_at",
  },
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn(() => ({})),
  desc: vi.fn(() => ({})),
  eq: vi.fn(() => ({})),
  gte: vi.fn(() => ({})),
}));

import { gateBudget, budgetBlockedResponse, attachBudgetEnvelope } from "./budget-gate";

const NEUTRAL_ENVELOPE = {
  allowed: true,
  monthlyUsdSpent: 0,
  monthlyUsdLimit: null,
  policy: "warn" as const,
  warningPercent: 80,
  warningThresholdCrossed: false,
  exceededAt: null,
  resolvedScope: null,
};

function chainWithRows(rows: unknown[]) {
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(() => Promise.resolve(rows)),
  };
  return chain;
}

beforeEach(() => {
  auditMock.mockReset();
  checkBudgetMock.mockReset();
  dbSelectMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("gateBudget", () => {
  it("returns blocked=false when the chokepoint allows (clean path, no audit)", async () => {
    checkBudgetMock.mockResolvedValueOnce({ ...NEUTRAL_ENVELOPE, monthlyUsdLimit: 100, monthlyUsdSpent: 12 });
    const outcome = await gateBudget({ orgId: "org-a", userId: "u-1", action: "ai.workflow.explained" });
    expect(outcome.blocked).toBe(false);
    expect(outcome.envelope.monthlyUsdLimit).toBe(100);
    expect(auditMock).not.toHaveBeenCalled();
    expect(dbSelectMock).not.toHaveBeenCalled();
  });

  it("writes a billing.budget.exceeded audit row and returns blocked=true on block", async () => {
    checkBudgetMock.mockResolvedValueOnce({
      ...NEUTRAL_ENVELOPE,
      allowed: false,
      monthlyUsdLimit: 10,
      monthlyUsdSpent: 12,
      policy: "block",
      exceededAt: "workflow",
      resolvedScope: "workflow",
    });
    const outcome = await gateBudget({ orgId: "org-a", userId: "u-1", workflowId: "wf-1", action: "ai.workflow.explained" });
    expect(outcome.blocked).toBe(true);
    expect(outcome.envelope.exceededAt).toBe("workflow");
    expect(auditMock).toHaveBeenCalledWith(
      "org-a",
      "u-1",
      "billing.budget.exceeded",
      "ai",
      "wf-1",
      expect.objectContaining({
        scope: "workflow",
        exceededAt: "workflow",
        monthlyUsdSpent: 12,
        monthlyUsdLimit: 10,
        policy: "block",
        action: "ai.workflow.explained",
      }),
    );
  });

  it("writes a billing.budget.warned row when the warning threshold is crossed and no dupe is present", async () => {
    checkBudgetMock.mockResolvedValueOnce({
      ...NEUTRAL_ENVELOPE,
      monthlyUsdLimit: 100,
      monthlyUsdSpent: 85,
      warningThresholdCrossed: true,
      resolvedScope: "org",
    });
    dbSelectMock.mockReturnValueOnce(chainWithRows([])); // no existing warn rows in last 24h
    await gateBudget({ orgId: "org-a", userId: "u-1", action: "ai.workflow.explained" });
    expect(auditMock).toHaveBeenCalledWith(
      "org-a",
      "u-1",
      "billing.budget.warned",
      "ai",
      undefined,
      expect.objectContaining({
        scope: "org",
        monthlyUsdSpent: 85,
        monthlyUsdLimit: 100,
      }),
    );
  });

  it("de-dups the warned row when a matching row exists in the last 24h", async () => {
    checkBudgetMock.mockResolvedValueOnce({
      ...NEUTRAL_ENVELOPE,
      monthlyUsdLimit: 100,
      monthlyUsdSpent: 85,
      warningThresholdCrossed: true,
      resolvedScope: "org",
    });
    dbSelectMock.mockReturnValueOnce(chainWithRows([
      { id: "existing", metadata: { scope: "org", workflowId: null } },
    ]));
    await gateBudget({ orgId: "org-a", userId: "u-1", action: "ai.workflow.explained" });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("still writes billing.budget.warned when the de-dupe lookup fails", async () => {
    checkBudgetMock.mockResolvedValueOnce({
      ...NEUTRAL_ENVELOPE,
      monthlyUsdLimit: 100,
      monthlyUsdSpent: 85,
      warningThresholdCrossed: true,
      resolvedScope: "org",
    });
    dbSelectMock.mockImplementationOnce(() => {
      throw new Error("read replica down");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await gateBudget({ orgId: "org-a", userId: "u-1", action: "ai.workflow.explained" });
    expect(auditMock).toHaveBeenCalledWith(
      "org-a",
      "u-1",
      "billing.budget.warned",
      "ai",
      undefined,
      expect.objectContaining({
        scope: "org",
        monthlyUsdSpent: 85,
        monthlyUsdLimit: 100,
      }),
    );
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("never throws when the audit writer rejects (fail-soft)", async () => {
    checkBudgetMock.mockResolvedValueOnce({
      ...NEUTRAL_ENVELOPE,
      allowed: false,
      monthlyUsdLimit: 10,
      monthlyUsdSpent: 12,
      policy: "block",
      exceededAt: "org",
      resolvedScope: "org",
    });
    auditMock.mockRejectedValueOnce(new Error("db down"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const outcome = await gateBudget({ orgId: "org-a", userId: "u-1", action: "ai.workflow.explained" });
    expect(outcome.blocked).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("budgetBlockedResponse + attachBudgetEnvelope", () => {
  it("budgetBlockedResponse wraps the envelope with the standard error tag", () => {
    const envelope = { ...NEUTRAL_ENVELOPE, allowed: false, monthlyUsdLimit: 10, monthlyUsdSpent: 12 };
    expect(budgetBlockedResponse(envelope)).toEqual({
      error: "budget_exceeded",
      code: "budget_exceeded",
      params: {
        monthlyUsdSpent: envelope.monthlyUsdSpent,
        monthlyUsdLimit: envelope.monthlyUsdLimit,
        policy: envelope.policy,
        warningPercent: envelope.warningPercent,
      },
      budget: envelope,
    });
  });

  it("attachBudgetEnvelope merges into a success response without mutating it", () => {
    const original = { mode: "ai" as const, foo: 1 };
    const envelope = { ...NEUTRAL_ENVELOPE, monthlyUsdLimit: 100, monthlyUsdSpent: 5 };
    const merged = attachBudgetEnvelope(original, envelope);
    expect(merged).toEqual({ mode: "ai", foo: 1, budget: envelope });
    expect("budget" in original).toBe(false);
  });
});

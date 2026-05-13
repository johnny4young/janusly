import { afterEach, describe, expect, it, vi } from "vitest";

import {
  checkBudget,
  getBudgetChecker,
  setBudgetChecker,
  type BudgetCheckResult,
} from "./budget";

const FAIL_SOFT: BudgetCheckResult = {
  allowed: true,
  monthlyUsdSpent: 0,
  monthlyUsdLimit: null,
  policy: "warn",
  warningPercent: 80,
  warningThresholdCrossed: false,
  exceededAt: null,
  resolvedScope: null,
};

afterEach(() => {
  setBudgetChecker(null);
});

describe("budget chokepoint", () => {
  it("returns the fail-soft envelope when no checker is registered", async () => {
    expect(getBudgetChecker()).toBeNull();
    const result = await checkBudget({ orgId: "org-a" });
    expect(result).toEqual(FAIL_SOFT);
  });

  it("invokes the registered checker and forwards its result", async () => {
    const checker = vi.fn(async (): Promise<BudgetCheckResult> => ({
      ...FAIL_SOFT,
      monthlyUsdLimit: 100,
      monthlyUsdSpent: 42,
      exceededAt: null,
      resolvedScope: "org",
    }));
    setBudgetChecker(checker);
    const result = await checkBudget({ orgId: "org-a", workflowId: "wf-1", predictedCostUsd: 0.5 });
    expect(checker).toHaveBeenCalledWith({ orgId: "org-a", workflowId: "wf-1", predictedCostUsd: 0.5 });
    expect(result.monthlyUsdLimit).toBe(100);
    expect(result.monthlyUsdSpent).toBe(42);
    expect(result.resolvedScope).toBe("org");
  });

  it("returns a block-mode envelope when the checker reports allowed=false", async () => {
    setBudgetChecker(async () => ({
      ...FAIL_SOFT,
      allowed: false,
      monthlyUsdLimit: 10,
      monthlyUsdSpent: 12,
      policy: "block",
      exceededAt: "workflow",
      resolvedScope: "workflow",
    }));
    const result = await checkBudget({ orgId: "org-a", workflowId: "wf-1" });
    expect(result.allowed).toBe(false);
    expect(result.policy).toBe("block");
    expect(result.exceededAt).toBe("workflow");
  });

  it("fails open with a console warn when the checker throws", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setBudgetChecker(async () => {
      throw new Error("redis down");
    });
    const result = await checkBudget({ orgId: "org-a" });
    expect(result).toEqual(FAIL_SOFT);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[budget] checker threw"),
      expect.any(Error),
    );
    warnSpy.mockRestore();
  });

  it("setBudgetChecker(null) clears the registered checker", async () => {
    setBudgetChecker(async () => ({ ...FAIL_SOFT, monthlyUsdLimit: 100 }));
    expect(getBudgetChecker()).not.toBeNull();
    setBudgetChecker(null);
    expect(getBudgetChecker()).toBeNull();
    const result = await checkBudget({ orgId: "org-a" });
    expect(result.monthlyUsdLimit).toBeNull();
  });
});

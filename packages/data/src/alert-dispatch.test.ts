import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getAlertDispatcher,
  recordAlertEvent,
  setAlertDispatcher,
} from "./alert-dispatch";

afterEach(() => {
  setAlertDispatcher(null);
});

describe("alert-dispatch DI seam", () => {
  it("is a no-op when no dispatcher is registered", async () => {
    await expect(
      recordAlertEvent({ orgId: "o1", trigger: "dlq.entry_created", payload: {} }),
    ).resolves.toBeUndefined();
  });

  it("invokes the registered dispatcher", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    setAlertDispatcher(fn);
    await recordAlertEvent({ orgId: "o1", trigger: "budget.blocked", payload: { x: 1 } });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith({
      orgId: "o1",
      trigger: "budget.blocked",
      payload: { x: 1 },
    });
  });

  it("swallows dispatcher errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("redis blip"));
    setAlertDispatcher(fn);
    await expect(
      recordAlertEvent({ orgId: "o1", trigger: "limiter.degraded", payload: {} }),
    ).resolves.toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("last registration wins", () => {
    const a = vi.fn();
    const b = vi.fn();
    setAlertDispatcher(a);
    setAlertDispatcher(b);
    expect(getAlertDispatcher()).toBe(b);
  });
});

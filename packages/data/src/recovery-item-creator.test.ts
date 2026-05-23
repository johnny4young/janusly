import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getRecoveryItemCreator,
  recordRecoveryItemCreationEvent,
  setRecoveryItemCreator,
} from "./recovery-item-creator";

afterEach(() => {
  setRecoveryItemCreator(null);
});

describe("recovery-item-creator DI seam", () => {
  it("is a no-op when no creator is registered", async () => {
    await expect(
      recordRecoveryItemCreationEvent({ orgId: "o1", deadLetterId: "dl1" }),
    ).resolves.toBeUndefined();
  });

  it("invokes the registered creator with the event payload", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    setRecoveryItemCreator(fn);
    await recordRecoveryItemCreationEvent({
      orgId: "o1",
      deadLetterId: "dl1",
      workflowId: "wf-1",
      errorSignature: "Missing secret: X",
      createdBy: "system",
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith({
      orgId: "o1",
      deadLetterId: "dl1",
      workflowId: "wf-1",
      errorSignature: "Missing secret: X",
      createdBy: "system",
    });
  });

  it("swallows creator errors so the DLQ insert flow is never broken", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("db blip"));
    setRecoveryItemCreator(fn);
    await expect(
      recordRecoveryItemCreationEvent({ orgId: "o1", deadLetterId: "dl1" }),
    ).resolves.toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("last registration wins", () => {
    const a = vi.fn();
    const b = vi.fn();
    setRecoveryItemCreator(a);
    setRecoveryItemCreator(b);
    expect(getRecoveryItemCreator()).toBe(b);
  });
});

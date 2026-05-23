import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getRecoveryItemSeverityDefault,
  setRecoveryItemSeverityDefault,
} from "./recovery-item-severity-default";

afterEach(() => {
  setRecoveryItemSeverityDefault(null);
  vi.restoreAllMocks();
});

describe("recovery-item-severity-default DI seam", () => {
  it("returns null when no resolver is registered", async () => {
    const result = await getRecoveryItemSeverityDefault("default", "wf-1");
    expect(result).toBeNull();
  });

  it("returns the value the resolver produces", async () => {
    const resolver = vi.fn().mockResolvedValue("p1");
    setRecoveryItemSeverityDefault(resolver);
    const result = await getRecoveryItemSeverityDefault("default", "wf-1");
    expect(result).toBe("p1");
    expect(resolver).toHaveBeenCalledWith("default", "wf-1");
  });

  it("degrades to null on resolver throw + does not propagate", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setRecoveryItemSeverityDefault(async () => {
      throw new Error("postgres blip");
    });
    const result = await getRecoveryItemSeverityDefault("default", "wf-1");
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("last-write-wins on re-registration", async () => {
    setRecoveryItemSeverityDefault(async () => "p4");
    setRecoveryItemSeverityDefault(async () => "p2");
    expect(await getRecoveryItemSeverityDefault("default", "wf-1")).toBe("p2");
  });

  it("unregisters cleanly via null", async () => {
    setRecoveryItemSeverityDefault(async () => "p1");
    setRecoveryItemSeverityDefault(null);
    expect(await getRecoveryItemSeverityDefault("default", "wf-1")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import { isRecoveryQueueSort, RECOVERY_QUEUE_SORTS } from "./dlq";

describe("isRecoveryQueueSort", () => {
  it("accepts every declared sort key", () => {
    for (const sort of RECOVERY_QUEUE_SORTS) {
      expect(isRecoveryQueueSort(sort)).toBe(true);
    }
  });

  it("matches the web SORT_KEYS contract", () => {
    expect([...RECOVERY_QUEUE_SORTS]).toEqual(["newest", "oldest", "severity", "sla"]);
  });

  it("rejects unknown / malformed values", () => {
    for (const bad of ["", "sideways", "createdAt", "SEVERITY", null, undefined, 3]) {
      expect(isRecoveryQueueSort(bad)).toBe(false);
    }
  });
});

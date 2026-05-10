/**
 * Tests for the email-usage DI seam. Mirrors the rate-limit seam tests
 * — same shape, different role (telemetry write vs gating throw).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetEmailUsageRecorderForTests,
  getEmailUsageRecorder,
  setEmailUsageRecorder,
  type EmailUsageRecord,
  type EmailUsageRecorder,
} from "./email-usage";

afterEach(() => {
  _resetEmailUsageRecorderForTests();
});

describe("email-usage DI seam", () => {
  it("returns null when no recorder is registered", () => {
    expect(getEmailUsageRecorder()).toBeNull();
  });

  it("returns the registered recorder", async () => {
    const captured: EmailUsageRecord[] = [];
    const fake: EmailUsageRecorder = (record) => { captured.push(record); };
    setEmailUsageRecorder(fake);
    const recorder = getEmailUsageRecorder();
    expect(recorder).toBe(fake);
    await recorder?.({
      orgId: "org-1",
      to: "u@e.com",
      from: "s@e.com",
      provider: "noop",
      ok: false,
      error: "Mailer not configured",
      latencyMs: 5,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.orgId).toBe("org-1");
  });

  it("`_resetEmailUsageRecorderForTests` clears the registry", () => {
    setEmailUsageRecorder(vi.fn());
    expect(getEmailUsageRecorder()).not.toBeNull();
    _resetEmailUsageRecorderForTests();
    expect(getEmailUsageRecorder()).toBeNull();
  });
});

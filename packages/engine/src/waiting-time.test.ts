import { describe, expect, it } from "vitest";

import {
  materializeWaitingCheckpointMetadata,
  parseAbsoluteInstant,
  resolveApprovalWaitingConfig,
  resolveWaitUntilSchedule,
  WaitingConfigError,
} from "./waiting-time";

const NOW = Date.parse("2026-07-14T12:00:00.000Z");

describe("approval waiting config", () => {
  it("materializes a relative deadline from the waiting checkpoint clock", () => {
    expect(materializeWaitingCheckpointMetadata({
      kind: "approval",
      decisionTimeoutMs: 60_000,
      onTimeout: "fail",
    }, NOW)).toEqual({
      kind: "approval",
      decisionTimeoutMs: 60_000,
      deadlineAt: "2026-07-14T12:01:00.000Z",
      delayMs: 60_000,
      onTimeout: "fail",
    });
  });

  it("preserves legacy indefinite waits and optional ownership", () => {
    expect(resolveApprovalWaitingConfig({}, NOW)).toEqual({});
    expect(resolveApprovalWaitingConfig({ timeoutMs: 30_000 }, NOW)).toEqual({});
    expect(resolveApprovalWaitingConfig({ assignee: " operator-1 " }, NOW)).toEqual({ assignee: "operator-1" });
  });

  it("resolves relative and absolute deadlines with fail as the safe default", () => {
    expect(resolveApprovalWaitingConfig({ decisionTimeoutMs: 60_000 }, NOW)).toEqual({
      deadlineAt: "2026-07-14T12:01:00.000Z",
      delayMs: 60_000,
      onTimeout: "fail",
    });
    expect(resolveApprovalWaitingConfig({ until: "2026-07-14T12:05:00Z", onTimeout: "auto_reject" }, NOW)).toEqual({
      deadlineAt: "2026-07-14T12:05:00.000Z",
      delayMs: 300_000,
      onTimeout: "auto_reject",
    });
  });

  it("requires an escalation target and rejects conflicting or orphaned policy fields", () => {
    expectWaitingCode(
      () => resolveApprovalWaitingConfig({ decisionTimeoutMs: 1, until: "2026-07-14T12:05:00Z" }, NOW),
      "approval_conflicting_deadline",
    );
    expectWaitingCode(
      () => resolveApprovalWaitingConfig({ decisionTimeoutMs: 1, onTimeout: "escalate" }, NOW),
      "approval_escalation_missing_assignee",
    );
    expectWaitingCode(
      () => resolveApprovalWaitingConfig({ onTimeout: "fail" }, NOW),
      "approval_timeout_policy_without_deadline",
    );
    expectWaitingCode(
      () => resolveApprovalWaitingConfig({ decisionTimeoutMs: 1, escalateTo: "ops" }, NOW),
      "approval_escalation_without_policy",
    );
  });

  it("normalizes an escalation policy and treats an elapsed absolute deadline as due now", () => {
    expect(resolveApprovalWaitingConfig({
      assignee: "tier-1",
      until: "2026-07-14T11:59:00-00:00",
      onTimeout: "escalate",
      escalateTo: "tier-2",
    }, NOW)).toEqual({
      assignee: "tier-1",
      deadlineAt: "2026-07-14T11:59:00.000Z",
      delayMs: 0,
      onTimeout: "escalate",
      escalateTo: "tier-2",
    });
  });
});

describe("wait_until schedule", () => {
  it("resolves either an ISO duration or an absolute instant", () => {
    expect(resolveWaitUntilSchedule({ duration: "PT5M" }, NOW)).toEqual({
      delayMs: 300_000,
      wakeAt: "2026-07-14T12:05:00.000Z",
      source: "duration",
    });
    expect(resolveWaitUntilSchedule({ until: "2026-07-14T12:10:00+00:00" }, NOW)).toEqual({
      delayMs: 600_000,
      wakeAt: "2026-07-14T12:10:00.000Z",
      source: "until",
    });
  });

  it("rejects ambiguous and malformed schedules", () => {
    expectWaitingCode(() => resolveWaitUntilSchedule({}, NOW), "wait_until_missing_duration");
    expectWaitingCode(
      () => resolveWaitUntilSchedule({ duration: "PT1M", until: "2026-07-14T12:10:00Z" }, NOW),
      "wait_until_conflicting_time",
    );
    expectWaitingCode(() => resolveWaitUntilSchedule({ duration: "five minutes" }, NOW), "wait_until_invalid_duration");
    expectWaitingCode(() => resolveWaitUntilSchedule({ until: "2026-07-14 12:10" }, NOW), "wait_until_invalid_until");
  });
});

describe("parseAbsoluteInstant", () => {
  it("requires an explicit timezone", () => {
    expect(parseAbsoluteInstant("2026-07-14T12:00:00Z")).toBe(NOW);
    expect(parseAbsoluteInstant("2026-07-14T07:00:00-05:00")).toBe(NOW);
    expect(parseAbsoluteInstant("2026-07-14T12:00")).toBeNull();
    expect(parseAbsoluteInstant("2026-07-14")).toBeNull();
  });

  it("rejects normalized calendar overflow and invalid clock fields", () => {
    expect(parseAbsoluteInstant("2026-02-30T12:00:00Z")).toBeNull();
    expect(parseAbsoluteInstant("2026-04-31T12:00:00Z")).toBeNull();
    expect(parseAbsoluteInstant("2026-07-14T24:00:00Z")).toBeNull();
    expect(parseAbsoluteInstant("2026-07-14T12:60:00Z")).toBeNull();
    expect(parseAbsoluteInstant("2026-07-14T12:00:60Z")).toBeNull();
  });

  it("accepts leap days and rejects relative deadlines outside the Date range", () => {
    expect(parseAbsoluteInstant("2028-02-29T12:00:00Z")).not.toBeNull();
    expectWaitingCode(
      () => resolveApprovalWaitingConfig({ decisionTimeoutMs: Number.MAX_SAFE_INTEGER }, NOW),
      "approval_invalid_timeout",
    );
    expectWaitingCode(
      () => resolveWaitUntilSchedule({ duration: "P999999999999999999999Y" }, NOW),
      "wait_until_invalid_duration",
    );
  });
});

function expectWaitingCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error("Expected WaitingConfigError");
  } catch (err) {
    expect(err).toBeInstanceOf(WaitingConfigError);
    expect((err as WaitingConfigError).code).toBe(code);
  }
}

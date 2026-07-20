/**
 * Pure config resolution for persisted waiting checkpoints.
 *
 * Used by:
 * - `node-configs.ts` and `workflow-validation.ts` for authoring/runtime parity.
 * - `approval-timeout.ts` and `wait-until.ts` before scheduling delayed jobs.
 *
 * Invariants:
 * - Absolute instants require an ISO 8601 date-time with an explicit timezone.
 * - Approval deadlines accept exactly one of `decisionTimeoutMs` or `until`.
 * - `auto_reject` is a terminal policy; it never advances downstream work.
 * - A past absolute instant resolves to a zero delay so a saved workflow does
 *   not become invalid merely because its target time elapsed before a run.
 */

import { parseIsoDuration } from "./iso-duration";

export const approvalTimeoutPolicyValues = ["fail", "auto_reject", "escalate"] as const;
export type ApprovalTimeoutPolicy = (typeof approvalTimeoutPolicyValues)[number];

export type ApprovalWaitingConfig = {
  assignee?: string;
  decisionTimeoutMs?: number;
  deadlineAt?: string;
  delayMs?: number;
  onTimeout?: ApprovalTimeoutPolicy;
  escalateTo?: string;
};

/**
 * Start a relative approval deadline from the checkpoint transition rather
 * than from executor work (notably a slow Redis enqueue) that happens before
 * the node is available to operators.
 */
export function materializeWaitingCheckpointMetadata(
  metadata: unknown,
  checkpointMs: number,
): Record<string, unknown> {
  const value = asObject(metadata);
  if (value.kind !== "approval" || value.deadlineAt !== undefined) return value;
  const timeoutMs = value.decisionTimeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return value;
  const deadlineMs = checkpointMs + timeoutMs;
  if (!isDateTimestamp(deadlineMs)) return value;
  return {
    ...value,
    deadlineAt: new Date(deadlineMs).toISOString(),
    delayMs: timeoutMs,
  };
}

export type WaitUntilSchedule = {
  delayMs: number;
  wakeAt: string;
  source: "duration" | "until";
};

export class WaitingConfigError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "WaitingConfigError";
  }
}

const ISO_INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/;

/** Parse an unambiguous ISO 8601 instant, or return `null` for invalid input. */
export function parseAbsoluteInstant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  const match = ISO_INSTANT_PATTERN.exec(normalized);
  if (!match) return null;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , timezone, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = secondText ? Number(secondText) : 0;
  const offsetHour = offsetHourText ? Number(offsetHourText) : 0;
  const offsetMinute = offsetMinuteText ? Number(offsetMinuteText) : 0;

  if (
    month < 1 || month > 12 ||
    day < 1 || day > daysInMonth(year, month) ||
    hour > 23 || minute > 59 || second > 59 ||
    (timezone !== "Z" && (offsetHour > 23 || offsetMinute > 59))
  ) return null;

  const timestamp = Date.parse(normalized);
  return isDateTimestamp(timestamp) ? timestamp : null;
}

/** Resolve optional approval ownership plus its timeout policy. */
export function resolveApprovalWaitingConfig(config: unknown, nowMs = Date.now()): ApprovalWaitingConfig {
  const value = asObject(config);
  const assignee = readOptionalLabel(value.assignee);
  const escalateTo = readOptionalLabel(value.escalateTo);
  const hasTimeout = value.decisionTimeoutMs !== undefined;
  const hasUntil = value.until !== undefined;

  if (hasTimeout && hasUntil) {
    throw new WaitingConfigError(
      "approval_conflicting_deadline",
      "Approval node accepts either config.decisionTimeoutMs or config.until, not both",
    );
  }

  const rawPolicy = value.onTimeout;
  if (rawPolicy !== undefined && !isApprovalTimeoutPolicy(rawPolicy)) {
    throw new WaitingConfigError(
      "approval_invalid_timeout_policy",
      "Approval node config.onTimeout must be fail, auto_reject, or escalate",
    );
  }

  if (!hasTimeout && !hasUntil) {
    if (rawPolicy !== undefined) {
      throw new WaitingConfigError(
        "approval_timeout_policy_without_deadline",
        "Approval node config.onTimeout requires config.decisionTimeoutMs or config.until",
      );
    }
    if (escalateTo) {
      throw new WaitingConfigError(
        "approval_escalation_without_policy",
        "Approval node config.escalateTo requires onTimeout: escalate and a deadline",
      );
    }
    return assignee ? { assignee } : {};
  }

  let deadlineMs: number;
  if (hasTimeout) {
    if (typeof value.decisionTimeoutMs !== "number" || !Number.isSafeInteger(value.decisionTimeoutMs) || value.decisionTimeoutMs <= 0) {
      throw new WaitingConfigError(
        "approval_invalid_timeout",
        "Approval node config.decisionTimeoutMs must be a positive safe integer",
      );
    }
    deadlineMs = nowMs + value.decisionTimeoutMs;
    if (!isDateTimestamp(deadlineMs)) {
      throw new WaitingConfigError(
        "approval_invalid_timeout",
        "Approval node config.decisionTimeoutMs must resolve to a supported date-time",
      );
    }
  } else {
    const parsed = parseAbsoluteInstant(value.until);
    if (parsed === null) {
      throw new WaitingConfigError(
        "approval_invalid_until",
        "Approval node config.until must be an ISO 8601 date-time with an explicit timezone",
      );
    }
    deadlineMs = parsed;
  }

  const onTimeout = rawPolicy ?? "fail";
  if (onTimeout === "escalate" && !escalateTo) {
    throw new WaitingConfigError(
      "approval_escalation_missing_assignee",
      "Approval node onTimeout: escalate requires a non-empty config.escalateTo",
    );
  }
  if (onTimeout !== "escalate" && escalateTo) {
    throw new WaitingConfigError(
      "approval_escalation_without_policy",
      "Approval node config.escalateTo requires onTimeout: escalate",
    );
  }

  return {
    ...(assignee ? { assignee } : {}),
    deadlineAt: new Date(deadlineMs).toISOString(),
    delayMs: Math.max(0, deadlineMs - nowMs),
    onTimeout,
    ...(escalateTo ? { escalateTo } : {}),
  };
}

/** Resolve a duration- or instant-backed `wait_until` schedule. */
export function resolveWaitUntilSchedule(config: unknown, nowMs = Date.now()): WaitUntilSchedule {
  const value = asObject(config);
  const hasDuration = value.duration !== undefined;
  const hasUntil = value.until !== undefined;

  if (hasDuration && hasUntil) {
    throw new WaitingConfigError(
      "wait_until_conflicting_time",
      "wait_until accepts either config.duration or config.until, not both",
    );
  }
  if (!hasDuration && !hasUntil) {
    throw new WaitingConfigError(
      "wait_until_missing_duration",
      "wait_until requires config.duration or config.until",
    );
  }

  if (hasDuration) {
    if (typeof value.duration !== "string" || !value.duration.trim()) {
      throw new WaitingConfigError(
        "wait_until_invalid_duration",
        "wait_until.duration must be a valid ISO 8601 duration",
      );
    }
    const delayMs = parseIsoDuration(value.duration);
    if (delayMs === null || !Number.isFinite(delayMs)) {
      throw new WaitingConfigError(
        "wait_until_invalid_duration",
        `wait_until.duration must be a valid ISO 8601 duration, got: ${value.duration}`,
      );
    }
    if (delayMs <= 0) {
      throw new WaitingConfigError(
        "wait_until_non_positive_duration",
        `wait_until.duration must resolve to a positive number of milliseconds, got: ${delayMs}`,
      );
    }
    const wakeAtMs = nowMs + delayMs;
    if (!isDateTimestamp(wakeAtMs)) {
      throw new WaitingConfigError(
        "wait_until_invalid_duration",
        "wait_until.duration must resolve to a supported date-time",
      );
    }
    return {
      delayMs,
      wakeAt: new Date(wakeAtMs).toISOString(),
      source: "duration",
    };
  }

  const wakeAtMs = parseAbsoluteInstant(value.until);
  if (wakeAtMs === null) {
    throw new WaitingConfigError(
      "wait_until_invalid_until",
      "wait_until.until must be an ISO 8601 date-time with an explicit timezone",
    );
  }
  return {
    delayMs: Math.max(0, wakeAtMs - nowMs),
    wakeAt: new Date(wakeAtMs).toISOString(),
    source: "until",
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readOptionalLabel(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isApprovalTimeoutPolicy(value: unknown): value is ApprovalTimeoutPolicy {
  return approvalTimeoutPolicyValues.includes(value as ApprovalTimeoutPolicy);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isDateTimestamp(value: number): boolean {
  return Number.isFinite(value) && !Number.isNaN(new Date(value).getTime());
}

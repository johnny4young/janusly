/**
 * Unit coverage for recovery-feedback persistence and health projection.
 *
 * Used by: the recovery-health API route and the AI patch response. The
 * database builder is mocked here; the pure state classifier pins the
 * age-boundary semantics and the query test verifies tenant/workflow scope
 * is assembled before the durable projection is read.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const aggregateRows: unknown[] = [];
const eqMock = vi.fn();
const insertValuesMock = vi.fn();
const conflictUpdateMock = vi.fn();
const transactionMock = vi.fn();

vi.mock("@janusly/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(async () => aggregateRows),
          })),
        })),
      })),
    })),
    transaction: async (handler: (tx: unknown) => unknown) => {
      transactionMock();
      return handler({
        insert: (table: { __table?: string }) => ({
          values: (values: unknown) => {
            insertValuesMock(table.__table, values);
            return table.__table === "feedback_health"
              ? { onConflictDoUpdate: conflictUpdateMock }
              : Promise.resolve(undefined);
          },
        }),
      });
    },
  },
  recoveryFeedback: {
    __table: "feedback",
    id: "id_col",
    orgId: "org_id_col",
    userId: "user_id_col",
    deadLetterId: "dead_letter_id_col",
    workflowId: "workflow_id_col",
    suggestionMode: "suggestion_mode_col",
    approachLabel: "approach_label_col",
    accepted: "accepted_col",
    evalConsent: "eval_consent_col",
    rawConfidence: "raw_confidence_col",
    comment: "comment_col",
    createdAt: "created_at_col",
  } as Record<string, string>,
  recoveryFeedbackHealth: {
    __table: "feedback_health",
    orgId: "health_org_id_col",
    workflowId: "health_workflow_id_col",
    approachLabel: "health_approach_label_col",
    feedbackLastSeen: "health_feedback_last_seen_col",
    acceptedFixLastSeen: "health_accepted_fix_last_seen_col",
  } as Record<string, string>,
}));

vi.mock("drizzle-orm", () => ({
  and: (...conditions: unknown[]) => ({ and: conditions }),
  asc: (column: unknown) => ({ asc: column }),
  desc: (column: unknown) => ({ desc: column }),
  eq: (...values: unknown[]) => {
    eqMock(...values);
    return { eq: values };
  },
  gte: (column: unknown, value: unknown) => ({ gte: [column, value] }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ text: strings.join("?"), values }),
}));

import {
  buildRecoveryFeedbackHealth,
  queryRecoveryFeedbackHealth,
  recordRecoveryFeedback,
} from "./recoveryFeedbackRepo";

beforeEach(() => {
  aggregateRows.length = 0;
  eqMock.mockReset();
  insertValuesMock.mockReset();
  conflictUpdateMock.mockReset();
  transactionMock.mockReset();
  conflictUpdateMock.mockResolvedValue(undefined);
});

describe("recordRecoveryFeedback", () => {
  const baseInput = {
    orgId: "org-write",
    userId: "user-write",
    deadLetterId: "dlq-write",
    workflowId: "workflow-write",
    suggestionMode: "ai" as const,
    approachLabel: "add_retry" as const,
    comment: null,
  };

  it("writes the source decision and durable health projection in one transaction on acceptance", async () => {
    await recordRecoveryFeedback({ ...baseInput, accepted: true });

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(insertValuesMock).toHaveBeenCalledWith("feedback", expect.objectContaining({
      orgId: "org-write",
      workflowId: "workflow-write",
      accepted: true,
      createdAt: expect.any(Date),
    }));
    expect(insertValuesMock).toHaveBeenCalledWith("feedback_health", expect.objectContaining({
      orgId: "org-write",
      workflowId: "workflow-write",
      approachLabel: "add_retry",
      feedbackLastSeen: expect.any(Date),
      acceptedFixLastSeen: expect.any(Date),
    }));
    const conflict = conflictUpdateMock.mock.calls[0]?.[0] as { set: Record<string, { text: string }> };
    expect(conflict.set.feedbackLastSeen.text).toContain("GREATEST")
    expect(conflict.set.acceptedFixLastSeen.text).toContain("GREATEST")
  });

  it("advances only the feedback clock on a rejection so a prior accepted fix remains visible", async () => {
    await recordRecoveryFeedback({ ...baseInput, accepted: false });

    expect(insertValuesMock).toHaveBeenCalledWith("feedback_health", expect.objectContaining({
      acceptedFixLastSeen: null,
    }));
    const conflict = conflictUpdateMock.mock.calls[0]?.[0] as {
      set: { feedbackLastSeen: { text: string }; acceptedFixLastSeen?: { text: string } };
    };
    expect(conflict.set.feedbackLastSeen.text).toContain("GREATEST")
    expect(conflict.set.acceptedFixLastSeen).toBeUndefined();
  });
});

describe("buildRecoveryFeedbackHealth", () => {
  const now = new Date("2026-07-10T12:00:00.000Z");

  it("distinguishes active, stale, and never-accepted feedback", () => {
    const health = buildRecoveryFeedbackHealth([
      {
        approachLabel: "add_retry",
        feedbackLastSeen: new Date("2026-07-09T12:00:00.000Z"),
        acceptedFixLastSeen: new Date("2026-07-09T12:00:00.000Z"),
      },
      {
        approachLabel: "raise_timeout",
        feedbackLastSeen: new Date("2026-05-01T12:00:00.000Z"),
        acceptedFixLastSeen: new Date("2026-05-01T12:00:00.000Z"),
      },
      {
        approachLabel: "fix_url",
        feedbackLastSeen: new Date("2026-07-08T12:00:00.000Z"),
        acceptedFixLastSeen: null,
      },
    ], { now, windowDays: 30 });

    expect(health).toMatchObject({
      windowDays: 30,
      approaches: [
        { approachLabel: "add_retry", acceptedFixAgeDays: 1, state: "active" },
        { approachLabel: "raise_timeout", acceptedFixAgeDays: 70, state: "stale" },
        { approachLabel: "fix_url", acceptedFixAgeDays: null, state: "no_accepted_fix" },
      ],
    });
  });

  it("keeps a same-day accepted fix active and clamps a future timestamp to zero days", () => {
    const health = buildRecoveryFeedbackHealth([{
      approachLabel: "other",
      feedbackLastSeen: new Date("2026-07-11T12:00:00.000Z"),
      acceptedFixLastSeen: new Date("2026-07-11T12:00:00.000Z"),
    }], { now, windowDays: 30 });

    expect(health.approaches[0]).toMatchObject({ acceptedFixAgeDays: 0, state: "active" });
  });

  it("drops an invalid aggregate timestamp instead of emitting an unusable health row", () => {
    const health = buildRecoveryFeedbackHealth([{
      approachLabel: "other",
      feedbackLastSeen: new Date("invalid"),
      acceptedFixLastSeen: null,
    }], { now });

    expect(health.approaches).toEqual([]);
  });
});

describe("queryRecoveryFeedbackHealth", () => {
  it("reads the durable org-scoped workflow projection into the public snapshot", async () => {
    aggregateRows.push({
      approachLabel: "add_retry",
      feedbackLastSeen: new Date("2026-07-09T12:00:00.000Z"),
      acceptedFixLastSeen: new Date("2026-07-09T12:00:00.000Z"),
    });

    const health = await queryRecoveryFeedbackHealth("org-a", "workflow-a", {
      now: new Date("2026-07-10T12:00:00.000Z"),
    });

    expect(eqMock).toHaveBeenCalledWith("health_org_id_col", "org-a");
    expect(eqMock).toHaveBeenCalledWith("health_workflow_id_col", "workflow-a");
    expect(health.approaches).toMatchObject([
      { approachLabel: "add_retry", acceptedFixAgeDays: 1, state: "active" },
    ]);
  });
});

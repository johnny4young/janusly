/**
 * Real-Postgres coverage for durable recovery-feedback health.
 *
 * Proves a feedback decision writes its source row and the compact
 * `(orgId, workflowId, approachLabel)` projection atomically enough for the
 * read path to distinguish stale, active, and never-accepted approaches after
 * the prompt's rolling window has elapsed.
 */

import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { db, recoveryFeedback, recoveryFeedbackHealth } from "@janusly/db";
import { queryRecoveryFeedbackHealth, recordRecoveryFeedback } from "../recoveryFeedbackRepo";

const RUN_TAG = `${Date.now()}-${process.pid}`;
const ORG = `it-feedback-health-${RUN_TAG}`;
const OTHER_ORG = `it-feedback-health-other-${RUN_TAG}`;
const WORKFLOW = `workflow-${RUN_TAG}`;

async function record(input: {
  orgId?: string;
  approachLabel: "add_retry" | "raise_timeout";
  accepted: boolean;
}) {
  await recordRecoveryFeedback({
    orgId: input.orgId ?? ORG,
    userId: "operator",
    deadLetterId: `dlq-${input.approachLabel}-${input.accepted ? "accepted" : "rejected"}`,
    workflowId: WORKFLOW,
    suggestionMode: "ai",
    approachLabel: input.approachLabel,
    accepted: input.accepted,
    comment: null,
    rawConfidence: 80,
  });
}

afterAll(async () => {
  for (const orgId of [ORG, OTHER_ORG]) {
    await db.delete(recoveryFeedbackHealth).where(eq(recoveryFeedbackHealth.orgId, orgId));
    await db.delete(recoveryFeedback).where(eq(recoveryFeedback.orgId, orgId));
  }
});

describe("recovery feedback health (real Postgres)", () => {
  it("keeps the accepted-fix clock when a later rejection refreshes feedback", async () => {
    await record({ approachLabel: "add_retry", accepted: true });
    await record({ approachLabel: "add_retry", accepted: false });
    await record({ approachLabel: "raise_timeout", accepted: false });
    await record({ orgId: OTHER_ORG, approachLabel: "add_retry", accepted: true });

    const rows = await db
      .select()
      .from(recoveryFeedbackHealth)
      .where(and(
        eq(recoveryFeedbackHealth.orgId, ORG),
        eq(recoveryFeedbackHealth.workflowId, WORKFLOW),
      ));
    expect(rows).toHaveLength(2);

    const retry = rows.find((row) => row.approachLabel === "add_retry");
    const timeout = rows.find((row) => row.approachLabel === "raise_timeout");
    expect(retry?.acceptedFixLastSeen).toBeInstanceOf(Date);
    expect(retry?.feedbackLastSeen.getTime()).toBeGreaterThanOrEqual(retry?.acceptedFixLastSeen?.getTime() ?? 0);
    expect(timeout?.acceptedFixLastSeen).toBeNull();

    const fresh = await queryRecoveryFeedbackHealth(ORG, WORKFLOW);
    expect(fresh.approaches).toEqual(expect.arrayContaining([
      expect.objectContaining({ approachLabel: "add_retry", state: "active" }),
      expect.objectContaining({ approachLabel: "raise_timeout", state: "no_accepted_fix" }),
    ]));

    const stale = await queryRecoveryFeedbackHealth(ORG, WORKFLOW, {
      now: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000),
      windowDays: 30,
    });
    expect(stale.approaches).toEqual(expect.arrayContaining([
      expect.objectContaining({ approachLabel: "add_retry", state: "stale" }),
    ]));

    const other = await queryRecoveryFeedbackHealth(OTHER_ORG, WORKFLOW);
    expect(other.approaches).toHaveLength(1);
    expect(other.approaches[0]).toMatchObject({ approachLabel: "add_retry", state: "active" });
  });
});

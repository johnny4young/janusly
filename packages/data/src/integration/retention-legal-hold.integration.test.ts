/**
 * Real-Postgres proof that a future legal hold blocks retention deletion for
 * the three compliance-sensitive tables, while null and expired holds remain
 * eligible. The unit suite pins SQL shape; this suite proves SQL semantics.
 */

import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { auditLogs, db, runEvents, runs, usageEvents } from "@janusly/db";
import {
  deleteExpiredAuditLogsForOrg,
  deleteExpiredRunEventsForOrg,
  deleteExpiredUsageEventsForOrg,
} from "../retentionRepo";

const STAMP = `${Date.now()}-${process.pid}`;
const ORG = `retention-hold-${STAMP}`;
const RUN_ID = `retention-hold-run-${STAMP}`;
const HELD_IDS = {
  runEvent: `retention-hold-run-event-${STAMP}`,
  usageEvent: `retention-hold-usage-${STAMP}`,
  auditLog: `retention-hold-audit-${STAMP}`,
};

afterAll(async () => {
  await db.delete(runEvents).where(eq(runEvents.runId, RUN_ID));
  await db.delete(usageEvents).where(eq(usageEvents.orgId, ORG));
  await db.delete(auditLogs).where(eq(auditLogs.orgId, ORG));
  await db.delete(runs).where(and(eq(runs.id, RUN_ID), eq(runs.orgId, ORG)));
});

describe("retention legal holds — real Postgres", () => {
  it("preserves future-held rows and deletes expired or unheld rows", async () => {
    const old = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
    const futureHold = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const expiredHold = new Date(Date.now() - 24 * 60 * 60 * 1000);

    await db.insert(runs).values({
      id: RUN_ID,
      orgId: ORG,
      workflowVersionId: `retention-version-${STAMP}`,
      status: "succeeded",
      createdAt: old,
    });
    await db.insert(runEvents).values([
      { id: HELD_IDS.runEvent, runId: RUN_ID, type: "held", createdAt: old, holdUntil: futureHold },
      { id: `retention-expired-run-event-${STAMP}`, runId: RUN_ID, type: "expired", createdAt: old, holdUntil: expiredHold },
      { id: `retention-unheld-run-event-${STAMP}`, runId: RUN_ID, type: "unheld", createdAt: old },
    ]);
    await db.insert(usageEvents).values([
      { id: HELD_IDS.usageEvent, orgId: ORG, metric: "held", createdAt: old, holdUntil: futureHold },
      { id: `retention-expired-usage-${STAMP}`, orgId: ORG, metric: "expired", createdAt: old, holdUntil: expiredHold },
      { id: `retention-unheld-usage-${STAMP}`, orgId: ORG, metric: "unheld", createdAt: old },
    ]);
    await db.insert(auditLogs).values([
      { id: HELD_IDS.auditLog, orgId: ORG, action: "retention.held", createdAt: old, holdUntil: futureHold },
      { id: `retention-expired-audit-${STAMP}`, orgId: ORG, action: "retention.expired", createdAt: old, holdUntil: expiredHold },
      { id: `retention-unheld-audit-${STAMP}`, orgId: ORG, action: "retention.unheld", createdAt: old },
    ]);

    const [runResult, usageResult, auditResult] = await Promise.all([
      deleteExpiredRunEventsForOrg({ orgId: ORG, retentionDays: 30 }),
      deleteExpiredUsageEventsForOrg({ orgId: ORG, retentionDays: 30 }),
      deleteExpiredAuditLogsForOrg({ orgId: ORG, retentionDays: 30 }),
    ]);
    expect([runResult.rowsDeleted, usageResult.rowsDeleted, auditResult.rowsDeleted]).toEqual([2, 2, 2]);

    const [remainingRunEvents, remainingUsage, remainingAudit] = await Promise.all([
      db.select({ id: runEvents.id }).from(runEvents).where(inArray(runEvents.id, [
        HELD_IDS.runEvent,
        `retention-expired-run-event-${STAMP}`,
        `retention-unheld-run-event-${STAMP}`,
      ])),
      db.select({ id: usageEvents.id }).from(usageEvents).where(eq(usageEvents.orgId, ORG)),
      db.select({ id: auditLogs.id }).from(auditLogs).where(eq(auditLogs.orgId, ORG)),
    ]);
    expect(remainingRunEvents.map((row) => row.id)).toEqual([HELD_IDS.runEvent]);
    expect(remainingUsage.map((row) => row.id)).toEqual([HELD_IDS.usageEvent]);
    expect(remainingAudit.map((row) => row.id)).toEqual([HELD_IDS.auditLog]);
  });
});

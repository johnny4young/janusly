/**
 * Integration tests (real Postgres) for the recovery-queue SQL that lives in
 * `apps/api/src/dlq.ts` (not `@janusly/data`): the `day` drill-in filter used
 * by Recovery Center heatmap click-throughs and the org scoping. The mocked-DB
 * unit tests can't prove the actual `created_at ∈ [day, day+1)` WHERE, so this
 * exercises it against a live DB. Unique org id + cleanup.
 */

import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { db, deadLetters, runs } from "@janusly/db";
import { getRecoveryDrillProvenance, listRecoveryQueue } from "../dlq";

const RUN_TAG = `${Date.now()}-${process.pid}`;
const ORG = `it-dlq-${RUN_TAG}`;
const ORG_OTHER = `it-dlq-other-${RUN_TAG}`;

afterAll(async () => {
  await db.delete(deadLetters).where(eq(deadLetters.orgId, ORG));
  await db.delete(deadLetters).where(eq(deadLetters.orgId, ORG_OTHER));
  await db.delete(runs).where(eq(runs.orgId, ORG));
  await db.delete(runs).where(eq(runs.orgId, ORG_OTHER));
});

async function seedDl(org: string, id: string, createdAt: Date): Promise<void> {
  await db.insert(deadLetters).values({
    id,
    orgId: org,
    runId: `run-${id}`,
    nodeId: "n",
    attempt: 1,
    workflowJson: { id: "wf", nodes: [], edges: [] },
    nodeJson: { id: "n", type: "noop", config: {} },
    errorJson: { message: "boom" },
    status: "open",
    createdAt,
  });
}

describe("listRecoveryQueue day filter (real Postgres)", () => {
  it("restricts to created_at within the requested UTC day, and ignores malformed", async () => {
    // 2 on 2026-03-01, 1 on 2026-03-02 (+ one just before midnight to guard the boundary).
    await seedDl(ORG, `${RUN_TAG}-a1`, new Date("2026-03-01T09:00:00.000Z"));
    await seedDl(ORG, `${RUN_TAG}-a2`, new Date("2026-03-01T23:59:59.000Z"));
    await seedDl(ORG, `${RUN_TAG}-b1`, new Date("2026-03-02T00:00:01.000Z"));

    const dayA = await listRecoveryQueue(ORG, { day: "2026-03-01" });
    const dayAIds = dayA.map((r) => r.id).filter((id) => id.startsWith(RUN_TAG));
    expect(dayAIds.sort()).toEqual([`${RUN_TAG}-a1`, `${RUN_TAG}-a2`]);
    expect(dayAIds).not.toContain(`${RUN_TAG}-b1`);

    const dayB = await listRecoveryQueue(ORG, { day: "2026-03-02" });
    expect(dayB.map((r) => r.id).filter((id) => id.startsWith(RUN_TAG))).toEqual([`${RUN_TAG}-b1`]);

    // Malformed day → filter dropped → all three surface.
    const bad = await listRecoveryQueue(ORG, { day: "not-a-day" });
    expect(bad.map((r) => r.id).filter((id) => id.startsWith(RUN_TAG))).toHaveLength(3);
  });

  it("scopes strictly to the org", async () => {
    await seedDl(ORG, `${RUN_TAG}-iso-a`, new Date("2026-03-05T10:00:00.000Z"));
    await seedDl(ORG_OTHER, `${RUN_TAG}-iso-b`, new Date("2026-03-05T10:00:00.000Z"));

    const mine = await listRecoveryQueue(ORG, { day: "2026-03-05" });
    const ids = mine.map((r) => r.id);
    expect(ids).toContain(`${RUN_TAG}-iso-a`);
    expect(ids).not.toContain(`${RUN_TAG}-iso-b`);
  });
});

describe("getRecoveryDrillProvenance (real Postgres)", () => {
  it("returns only the bounded projection and reasserts org scope", async () => {
    const runId = `${RUN_TAG}-drill-run`;
    await db.insert(runs).values({
      id: runId,
      orgId: ORG,
      workflowVersionId: `${runId}-version`,
      status: "failed",
      inputJson: {
        workflow: { private: "not returned" },
        drill: {
          kind: "solution_pack_drill",
          packId: "incident-triage",
          fixtureId: "worker_interrupted_during_page",
          failureMode: "worker_stalled",
          recoveryPath: "stalled_node_reaper",
          thresholdMinutes: 60,
        },
      },
    });

    await expect(getRecoveryDrillProvenance(ORG, runId)).resolves.toEqual({
      kind: "solution_pack_drill",
      packId: "incident-triage",
      fixtureId: "worker_interrupted_during_page",
      recoveryPath: "stalled_node_reaper",
    });
    await expect(getRecoveryDrillProvenance(ORG_OTHER, runId)).resolves.toBeNull();
  });
});

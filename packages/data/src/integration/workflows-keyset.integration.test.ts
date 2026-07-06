/**
 * Integration tests (real Postgres) for the Flows-list keyset pagination —
 * the active list (`createdAt DESC, id DESC`) and the Trash list
 * (`deletedAt DESC, id DESC`). Proves the `before` cursor never overlaps or
 * skips a row across pages, that soft-deleted rows are excluded from the active
 * list, and that only soft-deleted rows appear in Trash. Unique org id +
 * cleanup so rows never collide.
 */

import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { db, workflows } from "@janusly/db";
import { listDeletedWorkflowsWithRunSummary, listWorkflowsWithRunSummary } from "../workflowsListRepo";

const RUN_TAG = `${Date.now()}-${process.pid}`;
const ORG = `it-wf-${RUN_TAG}`;

afterAll(async () => {
  await db.delete(workflows).where(eq(workflows.orgId, ORG));
});

describe("Flows list keyset pagination (real Postgres)", () => {
  it("active list pages newest-first with no overlap/skip and excludes soft-deleted", async () => {
    const base = Date.UTC(2026, 0, 1, 0, 0, 0);
    // 5 active (1 min apart) + 2 soft-deleted.
    for (let i = 0; i < 5; i++) {
      await db.insert(workflows).values({ id: `${RUN_TAG}-a${i}`, orgId: ORG, name: `A${i}`, createdAt: new Date(base + i * 60_000) });
    }
    for (let i = 0; i < 2; i++) {
      await db.insert(workflows).values({ id: `${RUN_TAG}-d${i}`, orgId: ORG, name: `D${i}`, createdAt: new Date(base), deletedAt: new Date(base + i * 60_000) });
    }

    // Walk the active list one keyset page (size 2) at a time.
    const seen: string[] = [];
    let before: { createdAt: Date; id: string } | undefined;
    for (let page = 0; page < 20; page++) {
      const rows = await listWorkflowsWithRunSummary(ORG, 2, before ? { before } : {});
      if (rows.length === 0) break;
      seen.push(...rows.map((r) => r.id));
      const last = rows[rows.length - 1]!;
      if (rows.length < 2 || !last.createdAt) break;
      before = { createdAt: last.createdAt, id: last.id };
    }

    // All 5 active surfaced once, newest-first; no soft-deleted leaked in.
    expect(seen).toEqual([
      `${RUN_TAG}-a4`,
      `${RUN_TAG}-a3`,
      `${RUN_TAG}-a2`,
      `${RUN_TAG}-a1`,
      `${RUN_TAG}-a0`,
    ]);
    expect(seen).not.toContain(`${RUN_TAG}-d0`);
    expect(seen).not.toContain(`${RUN_TAG}-d1`);
  });

  it("trash list pages newest-deleted-first with no overlap/skip and only soft-deleted rows", async () => {
    const seen: string[] = [];
    let before: { deletedAt: Date; id: string } | undefined;
    for (let page = 0; page < 20; page++) {
      const rows = await listDeletedWorkflowsWithRunSummary(ORG, 1, before);
      if (rows.length === 0) break;
      seen.push(...rows.map((r) => r.id));
      const last = rows[rows.length - 1]!;
      if (!last.deletedAt) break;
      before = { deletedAt: last.deletedAt, id: last.id };
    }

    // Only the 2 soft-deleted rows, newest deletedAt first (d1 deleted after d0);
    // page size 1 forces the cursor to advance every page (no overlap/skip).
    expect(seen).toEqual([`${RUN_TAG}-d1`, `${RUN_TAG}-d0`]);
    expect(seen).not.toContain(`${RUN_TAG}-a0`);
  });
});

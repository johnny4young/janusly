import { beforeEach, describe, expect, it, vi } from "vitest";

const { selectFromMock } = vi.hoisted(() => ({
  selectFromMock: vi.fn(),
}));

vi.mock("@janusly/db", () => ({
  db: {
    select: vi.fn(() => ({ from: selectFromMock })),
  },
  autoHealingRuns: {
    orgId: "auto.org_id",
    deadLetterId: "auto.dead_letter_id",
    signature: "auto.signature",
    status: "auto.status",
  },
  deadLetters: {
    id: "dlq.id",
    orgId: "dlq.org_id",
    workflowJson: "dlq.workflow_json",
    nodeId: "dlq.node_id",
    errorJson: "dlq.error_json",
  },
  recoveryImpactEvents: {
    deadLetterId: "impact.dead_letter_id",
    orgId: "impact.org_id",
  },
}));

import {
  AUTO_HEALING_AUTONOMY_FACT_LIMIT,
  listAutoHealingAutonomyContexts,
  queryVerifiedAutoHealingRecoveries,
} from "./autoHealingAutonomyRepo";

beforeEach(() => {
  selectFromMock.mockReset();
});

describe("listAutoHealingAutonomyContexts", () => {
  it("short-circuits an empty request without touching the database", async () => {
    await expect(
      listAutoHealingAutonomyContexts("org-1", []),
    ).resolves.toEqual([]);
    expect(selectFromMock).not.toHaveBeenCalled();
  });

  it("returns bounded tenant-scoped failure snapshots", async () => {
    const rows = [{
      deadLetterId: "dlq-1",
      workflowJson: { nodes: [], edges: [] },
      nodeId: "fetch",
      errorJson: { code: "timeout" },
    }];
    const where = vi.fn().mockResolvedValue(rows);
    selectFromMock.mockReturnValue({ where });
    const ids = Array.from(
      { length: AUTO_HEALING_AUTONOMY_FACT_LIMIT + 10 },
      (_, index) => `dlq-${index}`,
    );

    await expect(
      listAutoHealingAutonomyContexts("org-1", ids),
    ).resolves.toEqual(rows);
    expect(where).toHaveBeenCalledOnce();
  });
});

describe("queryVerifiedAutoHealingRecoveries", () => {
  it("counts only grouped durable impact facts and normalizes DB numbers", async () => {
    const groupBy = vi.fn().mockResolvedValue([
      { signature: "sig-a", count: "3" },
      { signature: "sig-b", count: -2 },
    ]);
    const where = vi.fn(() => ({ groupBy }));
    const innerJoin = vi.fn(() => ({ where }));
    selectFromMock.mockReturnValue({ innerJoin });

    await expect(
      queryVerifiedAutoHealingRecoveries("org-1", [
        "sig-a",
        "sig-a",
        "sig-b",
      ]),
    ).resolves.toEqual([
      { signature: "sig-a", count: 3 },
      { signature: "sig-b", count: 0 },
    ]);
    expect(innerJoin).toHaveBeenCalledOnce();
    expect(groupBy).toHaveBeenCalledOnce();
  });
});

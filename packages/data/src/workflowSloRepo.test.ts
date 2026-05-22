import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const orderByMock = vi.fn();
const limitMock = vi.fn();
const updateWhereMock = vi.fn();

vi.mock("@janusly/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: orderByMock,
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: updateWhereMock,
      })),
    })),
  },
  workflowVersions: {
    id: "id_col",
    orgId: "org_id_col",
    workflowId: "workflow_id_col",
    sloJson: "slo_json_col",
    version: "version_col",
  },
}));

import { db } from "@janusly/db";
import type { WorkflowSlo } from "@janusly/shared";
import { getWorkflowSlo, setWorkflowSlo } from "./workflowSloRepo";

const dbMock = vi.mocked(db);

beforeEach(() => {
  vi.clearAllMocks();
  orderByMock.mockReset();
  limitMock.mockReset();
  updateWhereMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

const sampleSlo: WorkflowSlo = {
  successRatePercent: 95,
  mttrSeconds: null,
  p95DurationMs: 10_000,
  budgetBlocksPerWindow: null,
  stuckWaitingNodesMax: null,
  windowDays: 14,
};

function mockLatestRow(row: { id: string; sloJson: WorkflowSlo | null } | null) {
  orderByMock.mockReturnValueOnce({
    limit: vi.fn().mockResolvedValueOnce(row ? [row] : []),
  });
}

describe("getWorkflowSlo", () => {
  it("returns undefined when no versions exist", async () => {
    mockLatestRow(null);
    const result = await getWorkflowSlo("default", "missing-workflow");
    expect(result).toBeUndefined();
  });

  it("returns null SLO when latest version has no slo declared", async () => {
    mockLatestRow({ id: "v1", sloJson: null });
    const result = await getWorkflowSlo("default", "wf");
    expect(result).toEqual({ versionId: "v1", slo: null });
  });

  it("returns the persisted SLO from the latest version", async () => {
    mockLatestRow({ id: "v3", sloJson: sampleSlo });
    const result = await getWorkflowSlo("default", "wf");
    expect(result).toEqual({ versionId: "v3", slo: sampleSlo });
  });
});

describe("setWorkflowSlo", () => {
  it("returns undefined when no versions exist (no write)", async () => {
    mockLatestRow(null);
    const result = await setWorkflowSlo("default", "missing-workflow", sampleSlo);
    expect(result).toBeUndefined();
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("writes the SLO to the latest version and returns the prior value", async () => {
    mockLatestRow({ id: "v5", sloJson: null });
    updateWhereMock.mockResolvedValueOnce(undefined);
    const result = await setWorkflowSlo("default", "wf", sampleSlo);
    expect(result).toEqual({ versionId: "v5", previousSlo: null });
    expect(dbMock.update).toHaveBeenCalledTimes(1);
  });

  it("supports clearing the SLO to null and surfaces the previous value", async () => {
    mockLatestRow({ id: "v9", sloJson: sampleSlo });
    updateWhereMock.mockResolvedValueOnce(undefined);
    const result = await setWorkflowSlo("default", "wf", null);
    expect(result).toEqual({ versionId: "v9", previousSlo: sampleSlo });
  });
});

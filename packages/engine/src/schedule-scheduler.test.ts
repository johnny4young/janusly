import { beforeEach, describe, expect, it, vi } from "vitest";

const getWorkflowStatusMock = vi.hoisted(() => vi.fn(async () => ({ status: "active", pausedReason: null })));

vi.mock("./queue", () => ({
  workflowQueue: {
    upsertJobScheduler: vi.fn(),
    removeJobScheduler: vi.fn(),
  },
}));

vi.mock("./start-run", () => ({
  startRun: vi.fn(async () => ({ runId: "00000000-0000-0000-0000-000000000001" })),
}));

vi.mock("@janusly/data/src/scheduleEntriesRepo", () => ({
  deleteAllForWorkflow: vi.fn(async () => []),
  deletePriorVersions: vi.fn(async () => []),
  getScheduleEntryById: vi.fn(),
  listAllEnabled: vi.fn(async () => []),
  listForWorkflow: vi.fn(async () => []),
  recordFire: vi.fn(),
  upsertScheduleEntry: vi.fn(async (input) => ({
    id: "entry-" + input.nodeId,
    orgId: input.orgId,
    workflowId: input.workflowId,
    workflowVersionId: input.workflowVersionId,
    nodeId: input.nodeId,
    cronExpression: input.cronExpression,
    enabled: input.enabled,
    lastRunAt: null,
    lastRunId: null,
    createdBy: input.createdBy,
    createdAt: new Date(),
    updatedAt: new Date(),
  })),
}));

vi.mock("@janusly/data/src/upstreamHealthSourcesRepo", () => ({
  getWorkflowStatus: getWorkflowStatusMock,
  WORKFLOW_STATUS_ACTIVE: "active",
  WORKFLOW_STATUS_PAUSED_UPSTREAM: "paused_upstream_degraded",
}));

vi.mock("@janusly/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => []),
      })),
    })),
  },
  workflowVersions: {},
}));

import { workflowQueue } from "./queue";
import { startRun } from "./start-run";
import {
  deleteAllForWorkflow,
  deletePriorVersions,
  getScheduleEntryById,
  listAllEnabled,
  listForWorkflow,
  recordFire,
  upsertScheduleEntry,
} from "@janusly/data/src/scheduleEntriesRepo";
import {
  buildScheduleJobId,
  handleScheduleTrigger,
  replayAllScheduleEntries,
  syncWorkflowSchedules,
  unregisterAllForWorkflow,
} from "./schedule-scheduler";

const upsertJobSchedulerMock = vi.mocked(workflowQueue.upsertJobScheduler);
const removeJobSchedulerMock = vi.mocked(workflowQueue.removeJobScheduler);
const startRunMock = vi.mocked(startRun);
const upsertScheduleEntryMock = vi.mocked(upsertScheduleEntry);
const deletePriorVersionsMock = vi.mocked(deletePriorVersions);
const deleteAllForWorkflowMock = vi.mocked(deleteAllForWorkflow);
const listForWorkflowMock = vi.mocked(listForWorkflow);
const listAllEnabledMock = vi.mocked(listAllEnabled);
const getScheduleEntryByIdMock = vi.mocked(getScheduleEntryById);
const recordFireMock = vi.mocked(recordFire);

beforeEach(() => {
  upsertJobSchedulerMock.mockReset();
  removeJobSchedulerMock.mockReset();
  startRunMock.mockReset();
  startRunMock.mockResolvedValue({ runId: "00000000-0000-0000-0000-000000000001" });
  upsertScheduleEntryMock.mockClear();
  deletePriorVersionsMock.mockReset();
  deletePriorVersionsMock.mockResolvedValue([]);
  deleteAllForWorkflowMock.mockReset();
  deleteAllForWorkflowMock.mockResolvedValue([]);
  listForWorkflowMock.mockReset();
  listForWorkflowMock.mockResolvedValue([]);
  listAllEnabledMock.mockReset();
  listAllEnabledMock.mockResolvedValue([]);
  getScheduleEntryByIdMock.mockReset();
  recordFireMock.mockReset();
});

describe("buildScheduleJobId", () => {
  it("composes a deterministic id from the (orgId, versionId, nodeId) triple", () => {
    const id = buildScheduleJobId({ orgId: "default", workflowVersionId: "v1", nodeId: "s1" });
    expect(id).toBe("schedule:default:v1:s1");
  });

  it("changes when any component changes (no collisions across orgs / versions)", () => {
    expect(buildScheduleJobId({ orgId: "a", workflowVersionId: "v1", nodeId: "s1" })).not.toBe(
      buildScheduleJobId({ orgId: "b", workflowVersionId: "v1", nodeId: "s1" }),
    );
    expect(buildScheduleJobId({ orgId: "a", workflowVersionId: "v1", nodeId: "s1" })).not.toBe(
      buildScheduleJobId({ orgId: "a", workflowVersionId: "v2", nodeId: "s1" }),
    );
  });
});

describe("syncWorkflowSchedules", () => {
  it("registers a BullMQ scheduler for each enabled schedule node", async () => {
    await syncWorkflowSchedules({
      orgId: "default",
      workflowId: "wf1",
      workflowVersionId: "v1",
      nodes: [
        { id: "trigger", type: "schedule", config: { cronExpression: "0 9 * * *", enabled: true } },
        { id: "http", type: "http", config: { url: "https://example.com" } },
      ],
      createdBy: "user-1",
    });

    expect(upsertScheduleEntryMock).toHaveBeenCalledTimes(1);
    expect(upsertJobSchedulerMock).toHaveBeenCalledWith(
      "schedule:default:v1:trigger",
      { pattern: "0 9 * * *" },
      expect.objectContaining({ name: "schedule-trigger" }),
    );
  });

  it("removes the BullMQ scheduler but keeps the row when enabled=false (pause)", async () => {
    await syncWorkflowSchedules({
      orgId: "default",
      workflowId: "wf1",
      workflowVersionId: "v2",
      nodes: [
        { id: "trigger", type: "schedule", config: { cronExpression: "0 9 * * *", enabled: false } },
      ],
      createdBy: "user-1",
    });

    expect(upsertScheduleEntryMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    expect(upsertJobSchedulerMock).not.toHaveBeenCalled();
    expect(removeJobSchedulerMock).toHaveBeenCalledWith("schedule:default:v2:trigger");
  });

  it("removes prior-version BullMQ schedulers on a new save (version churn)", async () => {
    deletePriorVersionsMock.mockResolvedValueOnce([
      {
        id: "prior-1",
        orgId: "default",
        workflowId: "wf1",
        workflowVersionId: "v1",
        nodeId: "trigger",
        cronExpression: "0 9 * * *",
        enabled: true,
        lastRunAt: null,
        lastRunId: null,
        createdBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    await syncWorkflowSchedules({
      orgId: "default",
      workflowId: "wf1",
      workflowVersionId: "v2",
      nodes: [
        { id: "trigger", type: "schedule", config: { cronExpression: "*/5 * * * *" } },
      ],
      createdBy: "user-1",
    });

    expect(removeJobSchedulerMock).toHaveBeenCalledWith("schedule:default:v1:trigger");
    expect(upsertJobSchedulerMock).toHaveBeenCalledWith(
      "schedule:default:v2:trigger",
      { pattern: "*/5 * * * *" },
      expect.any(Object),
    );
  });

  it("skips schedule nodes with invalid cron expressions (logged, not thrown)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await syncWorkflowSchedules({
      orgId: "default",
      workflowId: "wf1",
      workflowVersionId: "v1",
      nodes: [
        { id: "bad", type: "schedule", config: { cronExpression: "wat" } },
      ],
      createdBy: null,
    });

    expect(upsertScheduleEntryMock).not.toHaveBeenCalled();
    expect(upsertJobSchedulerMock).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("unregisterAllForWorkflow", () => {
  it("clears every entry + BullMQ scheduler tied to the workflow", async () => {
    listForWorkflowMock.mockResolvedValueOnce([
      {
        id: "e1",
        orgId: "default",
        workflowId: "wf1",
        workflowVersionId: "v1",
        nodeId: "n1",
        cronExpression: "0 9 * * *",
        enabled: true,
        lastRunAt: null,
        lastRunId: null,
        createdBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "e2",
        orgId: "default",
        workflowId: "wf1",
        workflowVersionId: "v2",
        nodeId: "n1",
        cronExpression: "0 9 * * *",
        enabled: false,
        lastRunAt: null,
        lastRunId: null,
        createdBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    await unregisterAllForWorkflow("default", "wf1");

    expect(deleteAllForWorkflowMock).toHaveBeenCalledWith("default", "wf1");
    expect(removeJobSchedulerMock).toHaveBeenCalledWith("schedule:default:v1:n1");
    expect(removeJobSchedulerMock).toHaveBeenCalledWith("schedule:default:v2:n1");
  });
});

describe("replayAllScheduleEntries", () => {
  it("idempotently re-registers every enabled entry on worker boot", async () => {
    listAllEnabledMock.mockResolvedValueOnce([
      {
        id: "e1",
        orgId: "default",
        workflowId: "wf1",
        workflowVersionId: "v1",
        nodeId: "trigger",
        cronExpression: "0 9 * * *",
        enabled: true,
        lastRunAt: null,
        lastRunId: null,
        createdBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const count = await replayAllScheduleEntries();
    expect(count).toBe(1);
    expect(upsertJobSchedulerMock).toHaveBeenCalledWith(
      "schedule:default:v1:trigger",
      { pattern: "0 9 * * *" },
      expect.objectContaining({ name: "schedule-trigger" }),
    );
  });
});

describe("handleScheduleTrigger", () => {
  it("does nothing on a malformed payload", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await handleScheduleTrigger({ scheduleEntryId: 123 });
    expect(startRunMock).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("self-heals when the entry has been deleted between scheduler and worker (removes the actual BullMQ scheduler)", async () => {
    getScheduleEntryByIdMock.mockResolvedValueOnce(null);

    await handleScheduleTrigger({
      scheduleEntryId: "ghost",
      orgId: "spoofed-org",
      workflowVersionId: "spoofed-version",
      nodeId: "spoofed-node",
    }, "schedule:default:v1:trigger");

    expect(startRunMock).not.toHaveBeenCalled();
    expect(removeJobSchedulerMock).toHaveBeenCalledWith("schedule:default:v1:trigger");
  });

  it("does not trust stale payload hints when BullMQ did not provide a scheduler id", async () => {
    getScheduleEntryByIdMock.mockResolvedValueOnce(null);

    await handleScheduleTrigger({
      scheduleEntryId: "ghost",
      orgId: "victim-org",
      workflowVersionId: "victim-version",
      nodeId: "victim-trigger",
    });

    expect(startRunMock).not.toHaveBeenCalled();
    expect(removeJobSchedulerMock).not.toHaveBeenCalled();
  });

  it("removes the BullMQ scheduler and skips when the entry is disabled (using the row's orgId, not the payload's)", async () => {
    getScheduleEntryByIdMock.mockResolvedValueOnce({
      id: "e1",
      orgId: "default",
      workflowId: "wf1",
      workflowVersionId: "v1",
      nodeId: "trigger",
      cronExpression: "0 9 * * *",
      enabled: false,
      lastRunAt: null,
      lastRunId: null,
      createdBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await handleScheduleTrigger({
      scheduleEntryId: "e1",
      orgId: "default",
      workflowVersionId: "v1",
      nodeId: "trigger",
    });

    expect(startRunMock).not.toHaveBeenCalled();
    expect(removeJobSchedulerMock).toHaveBeenCalledWith("schedule:default:v1:trigger");
  });

  it("refuses cross-tenant payload spoofing — payload.orgId is ignored, only the persisted row's orgId is trusted", async () => {
    // An attacker submits a payload claiming `orgId: "attacker-org"` but
    // with a valid `scheduleEntryId` from the victim. The handler must
    // load by id alone, then use the ROW's orgId / versionId everywhere.
    getScheduleEntryByIdMock.mockResolvedValueOnce({
      id: "victim-entry",
      orgId: "victim-org",
      workflowId: "wf1",
      workflowVersionId: "v1",
      nodeId: "trigger",
      cronExpression: "0 9 * * *",
      enabled: true,
      lastRunAt: null,
      lastRunId: null,
      createdBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await handleScheduleTrigger({
      scheduleEntryId: "victim-entry",
      orgId: "attacker-org",
      workflowVersionId: "spoofed-version",
      nodeId: "trigger",
    });

    // The lookup uses ONLY the scheduleEntryId — proves the orgId hint
    // can't influence which row gets loaded.
    expect(getScheduleEntryByIdMock).toHaveBeenCalledWith("victim-entry");
    // `loadWorkflowSnapshot` in this mocked setup returns null (the db
    // select chain resolves to []), so `startRun` is never called.
    // The property under test is the LOOKUP path, not the run-spawn
    // path: payload.orgId never reaches the DB.
    expect(startRunMock).not.toHaveBeenCalled();
  });

  describe("pause gate", () => {
    function activeEntry() {
      return {
        id: "e1", orgId: "org-1", workflowId: "wf1", workflowVersionId: "v1", nodeId: "trigger",
        cronExpression: "0 9 * * *", enabled: true, lastRunAt: null, lastRunId: null,
        createdBy: null, createdAt: new Date(), updatedAt: new Date(),
      };
    }

    it("skips the tick when the workflow is paused — a cron that ignores the pause IS the flood", async () => {
      // The breaker exists to stop repeated failing runs, and in production
      // those come from the schedule. A pause only `/start` respected would
      // pause the button nobody was pressing.
      getScheduleEntryByIdMock.mockResolvedValueOnce(activeEntry());
      getWorkflowStatusMock.mockResolvedValueOnce({ status: "paused_circuit_breaker", pausedReason: "5 consecutive" } as never);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      await handleScheduleTrigger({ scheduleEntryId: "e1" });

      expect(startRunMock).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it("skips an upstream-outage pause too", async () => {
      getScheduleEntryByIdMock.mockResolvedValueOnce(activeEntry());
      getWorkflowStatusMock.mockResolvedValueOnce({ status: "paused_upstream_degraded", pausedReason: "stripe" } as never);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      await handleScheduleTrigger({ scheduleEntryId: "e1" });

      expect(startRunMock).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it("reads the status with the ROW's orgId, never a payload hint", async () => {
      getScheduleEntryByIdMock.mockResolvedValueOnce(activeEntry());
      getWorkflowStatusMock.mockResolvedValueOnce({ status: "paused_circuit_breaker", pausedReason: null } as never);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      await handleScheduleTrigger({ scheduleEntryId: "e1", orgId: "attacker-org", workflowVersionId: "x", nodeId: "y" });

      expect(getWorkflowStatusMock).toHaveBeenCalledWith("org-1", "wf1");
      warn.mockRestore();
    });

    it("does not gate an active workflow (the snapshot load is still reached)", async () => {
      getScheduleEntryByIdMock.mockResolvedValueOnce(activeEntry());
      getWorkflowStatusMock.mockResolvedValueOnce({ status: "active", pausedReason: null } as never);
      const err = vi.spyOn(console, "error").mockImplementation(() => {});

      await handleScheduleTrigger({ scheduleEntryId: "e1" });

      // The db mock resolves the snapshot select to [], so the handler stops
      // at "snapshot missing" — past the gate, which is the point.
      expect(err).toHaveBeenCalledWith("[schedule] workflow snapshot missing", expect.anything());
      err.mockRestore();
    });
  });
});

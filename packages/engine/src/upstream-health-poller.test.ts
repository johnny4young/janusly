/**
 * Unit tests for the upstream-health poller core (`pollOneSource`,
 * `isSourceDue`, scheduler registration).
 *
 * Mocks `./queue` (no Redis), `@janusly/db` (no DB for the audit insert), and
 * the data repo (no Postgres). Injects a fake fetcher so the parse → pause →
 * audit flow is exercised without the network.
 *
 * Covers the upstream-health awareness acceptance cases:
 *   - statuspage.io JSON → degraded → tagged workflows paused + audit written
 *   - recovery (operational) → paused workflows resumed
 *   - FAIL-OPEN on feed timeout/throw → NOTHING paused, error reason recorded
 *   - FAIL-OPEN on missing component → nothing paused
 *   - idempotent pause (repo returns [] when already paused → no extra audit)
 *   - isSourceDue interval gating
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./queue", () => ({
  maintenanceQueue: { upsertJobScheduler: vi.fn() },
}));

const auditInsertValues = vi.fn();
const recordSystemAuditMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@janusly/db", () => ({
  db: { insert: () => ({ values: auditInsertValues }) },
  auditLogs: {},
}));

vi.mock("@janusly/data", () => ({
  recordSystemAudit: recordSystemAuditMock,
  WORKFLOW_STATUS_PAUSED_UPSTREAM: "paused_upstream_degraded",
  listSourcesToPoll: vi.fn(),
  listWorkflowIdsTaggedWithSource: vi.fn(),
  pauseWorkflowsForUpstream: vi.fn(),
  resumeWorkflowsForUpstream: vi.fn(),
  recordUpstreamStatus: vi.fn(),
  recordUpstreamPollError: vi.fn(),
  findUpstreamHealthSourceByName: vi.fn(),
}));

import {
  listWorkflowIdsTaggedWithSource,
  pauseWorkflowsForUpstream,
  recordUpstreamPollError,
  recordUpstreamStatus,
  resumeWorkflowsForUpstream,
  type UpstreamHealthSource,
} from "@janusly/data";

import {
  DEFAULT_UPSTREAM_HEALTH_CRON,
  isSourceDue,
  pollOneSource,
  registerUpstreamHealthScheduler,
  UPSTREAM_HEALTH_JOB_ID,
} from "./upstream-health-poller";
import { maintenanceQueue } from "./queue";

const listTaggedMock = vi.mocked(listWorkflowIdsTaggedWithSource);
const pauseMock = vi.mocked(pauseWorkflowsForUpstream);
const resumeMock = vi.mocked(resumeWorkflowsForUpstream);
const recordStatusMock = vi.mocked(recordUpstreamStatus);
const recordErrorMock = vi.mocked(recordUpstreamPollError);
const upsertSchedulerMock = vi.mocked(maintenanceQueue.upsertJobScheduler);

function source(overrides: Partial<UpstreamHealthSource> = {}): UpstreamHealthSource {
  return {
    id: "src-1",
    orgId: "org-a",
    name: "stripe-prod",
    kind: "statuspage_io",
    url: "https://status.stripe.com/api/v2/components.json",
    expectedComponents: ["API"],
    checkIntervalSeconds: 60,
    enabled: true,
    lastStatus: null,
    lastDegraded: false,
    lastCheckedAt: null,
    lastErrorReason: null,
    createdBy: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  auditInsertValues.mockResolvedValue(undefined);
  recordSystemAuditMock.mockReset();
  recordSystemAuditMock.mockResolvedValue(undefined);
  recordStatusMock.mockResolvedValue(undefined);
  recordErrorMock.mockResolvedValue(undefined);
  listTaggedMock.mockResolvedValue([]);
  pauseMock.mockResolvedValue([]);
  resumeMock.mockResolvedValue([]);
});

describe("pollOneSource — degraded → pause", () => {
  it("pauses tagged workflows + writes audit when a watched component is degraded", async () => {
    listTaggedMock.mockResolvedValue(["wf-1", "wf-2"]);
    pauseMock.mockResolvedValue(["wf-1", "wf-2"]);
    const fetcher = vi.fn().mockResolvedValue({
      statusCode: 200,
      ok: true,
      body: JSON.stringify({ components: [{ name: "API", status: "major_outage" }] }),
    });

    const result = await pollOneSource(source(), fetcher);

    expect(result.parse.ok).toBe(true);
    if (result.parse.ok) expect(result.parse.degraded).toBe(true);
    expect(recordStatusMock).toHaveBeenCalledWith({ orgId: "org-a", id: "src-1", status: "major_outage", degraded: true });
    expect(pauseMock).toHaveBeenCalledWith({ orgId: "org-a", workflowIds: ["wf-1", "wf-2"], reason: expect.stringContaining("degraded") });
    expect(result.pausedWorkflowIds).toEqual(["wf-1", "wf-2"]);
    // One audit row per actually-flipped workflow.
    expect(recordSystemAuditMock).toHaveBeenCalledTimes(2);
    expect(recordSystemAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "workflow.paused.upstream", orgId: "org-a" }));
  });

  it("is idempotent — already-paused workflows (repo returns []) write no audit", async () => {
    listTaggedMock.mockResolvedValue(["wf-1"]);
    pauseMock.mockResolvedValue([]); // already paused
    const fetcher = vi.fn().mockResolvedValue({
      statusCode: 200,
      ok: true,
      body: JSON.stringify({ components: [{ name: "API", status: "degraded_performance" }] }),
    });

    const result = await pollOneSource(source(), fetcher);
    expect(result.pausedWorkflowIds).toEqual([]);
    expect(recordSystemAuditMock).not.toHaveBeenCalled();
  });
});

describe("pollOneSource — recovery → resume", () => {
  it("resumes paused workflows + writes audit when the component recovers", async () => {
    listTaggedMock.mockResolvedValue(["wf-1"]);
    resumeMock.mockResolvedValue(["wf-1"]);
    const fetcher = vi.fn().mockResolvedValue({
      statusCode: 200,
      ok: true,
      body: JSON.stringify({ components: [{ name: "API", status: "operational" }] }),
    });

    const result = await pollOneSource(source(), fetcher);
    expect(recordStatusMock).toHaveBeenCalledWith({ orgId: "org-a", id: "src-1", status: "operational", degraded: false });
    expect(resumeMock).toHaveBeenCalledWith({ orgId: "org-a", workflowIds: ["wf-1"] });
    expect(result.resumedWorkflowIds).toEqual(["wf-1"]);
    expect(pauseMock).not.toHaveBeenCalled();
    expect(recordSystemAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "workflow.resumed.upstream" }));
  });
});

describe("pollOneSource — FAIL-OPEN", () => {
  it("does NOT pause when the feed fetch throws (timeout) and records the error reason", async () => {
    listTaggedMock.mockResolvedValue(["wf-1"]);
    const fetcher = vi.fn().mockRejectedValue(new Error("HTTP request timed out after 10000ms"));

    const result = await pollOneSource(source(), fetcher);

    expect(result.failedOpen).toBe(true);
    expect(result.parse.ok).toBe(false);
    expect(pauseMock).not.toHaveBeenCalled();
    expect(recordStatusMock).not.toHaveBeenCalled();
    expect(recordErrorMock).toHaveBeenCalledWith({ orgId: "org-a", id: "src-1", reason: "unreachable" });
  });

  it("does NOT pause when a watched component is missing (component_not_found)", async () => {
    listTaggedMock.mockResolvedValue(["wf-1"]);
    const fetcher = vi.fn().mockResolvedValue({
      statusCode: 200,
      ok: true,
      body: JSON.stringify({ components: [{ name: "SomethingElse", status: "major_outage" }] }),
    });

    const result = await pollOneSource(source(), fetcher);
    expect(result.failedOpen).toBe(true);
    expect(pauseMock).not.toHaveBeenCalled();
    expect(recordStatusMock).not.toHaveBeenCalled();
    expect(recordErrorMock).toHaveBeenCalledWith({ orgId: "org-a", id: "src-1", reason: "component_not_found" });
  });

  it("does NOT pause when the body is not JSON (unparseable)", async () => {
    listTaggedMock.mockResolvedValue(["wf-1"]);
    const fetcher = vi.fn().mockResolvedValue({ statusCode: 200, ok: true, body: "<html>maintenance</html>" });

    const result = await pollOneSource(source(), fetcher);
    expect(result.failedOpen).toBe(true);
    expect(pauseMock).not.toHaveBeenCalled();
    expect(recordErrorMock).toHaveBeenCalledWith({ orgId: "org-a", id: "src-1", reason: "unparseable" });
  });
});

describe("pollOneSource — http_probe", () => {
  it("pauses on a non-2xx probe response", async () => {
    listTaggedMock.mockResolvedValue(["wf-1"]);
    pauseMock.mockResolvedValue(["wf-1"]);
    const fetcher = vi.fn().mockResolvedValue({ statusCode: 503, ok: false, body: "" });

    const result = await pollOneSource(source({ kind: "http_probe", expectedComponents: [] }), fetcher);
    expect(result.parse.ok).toBe(true);
    if (result.parse.ok) expect(result.parse.degraded).toBe(true);
    expect(pauseMock).toHaveBeenCalled();
  });

  it("does NOT JSON-parse the body for http_probe (a non-JSON 200 stays healthy)", async () => {
    listTaggedMock.mockResolvedValue([]);
    const fetcher = vi.fn().mockResolvedValue({ statusCode: 200, ok: true, body: "OK" });
    const result = await pollOneSource(source({ kind: "http_probe", expectedComponents: [] }), fetcher);
    expect(result.failedOpen).toBe(false);
    if (result.parse.ok) expect(result.parse.degraded).toBe(false);
  });
});

describe("isSourceDue", () => {
  it("is always due when never polled", () => {
    expect(isSourceDue(source({ lastCheckedAt: null }), Date.now())).toBe(true);
  });
  it("is due when the interval has elapsed", () => {
    const now = Date.now();
    const checkedAt = new Date(now - 61_000);
    expect(isSourceDue(source({ lastCheckedAt: checkedAt, checkIntervalSeconds: 60 }), now)).toBe(true);
  });
  it("is NOT due before the interval elapses", () => {
    const now = Date.now();
    const checkedAt = new Date(now - 10_000);
    expect(isSourceDue(source({ lastCheckedAt: checkedAt, checkIntervalSeconds: 60 }), now)).toBe(false);
  });
});

describe("registerUpstreamHealthScheduler", () => {
  beforeEach(() => {
    upsertSchedulerMock.mockReset();
    upsertSchedulerMock.mockResolvedValue(undefined as never);
  });

  it("registers the default cron when env is empty", async () => {
    await expect(registerUpstreamHealthScheduler({})).resolves.toBe(true);
    expect(upsertSchedulerMock).toHaveBeenCalledWith(
      UPSTREAM_HEALTH_JOB_ID,
      { pattern: DEFAULT_UPSTREAM_HEALTH_CRON },
      expect.objectContaining({ name: expect.any(String) }),
    );
  });

  it("honours JANUSLY_UPSTREAM_HEALTH_CRON", async () => {
    await registerUpstreamHealthScheduler({ JANUSLY_UPSTREAM_HEALTH_CRON: "*/5 * * * *" });
    expect(upsertSchedulerMock).toHaveBeenCalledWith(
      UPSTREAM_HEALTH_JOB_ID,
      { pattern: "*/5 * * * *" },
      expect.anything(),
    );
  });

  it("falls back to default on a malformed cron (never throws)", async () => {
    await expect(registerUpstreamHealthScheduler({ JANUSLY_UPSTREAM_HEALTH_CRON: "not a cron" })).resolves.toBe(true);
    expect(upsertSchedulerMock).toHaveBeenCalledWith(
      UPSTREAM_HEALTH_JOB_ID,
      { pattern: DEFAULT_UPSTREAM_HEALTH_CRON },
      expect.anything(),
    );
  });

  it("returns false (no throw) when upsertJobScheduler rejects", async () => {
    upsertSchedulerMock.mockRejectedValue(new Error("redis down"));
    await expect(registerUpstreamHealthScheduler({})).resolves.toBe(false);
  });
});

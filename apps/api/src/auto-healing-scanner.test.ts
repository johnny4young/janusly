/**
 * Pure-unit tests for the auto-healing scanner. Every external collaborator
 * is mocked: the BullMQ queue, the DLQ adapter, the LLM helper, the repo,
 * the DB. The tests pin the eight AC categories:
 *   - manual-review default (tenant flag off → no row)
 *   - process flag off → no row
 *   - loop breaker (records `loop_breaker_tripped`)
 *   - budget exceeded (records `budget_exceeded`)
 *   - idempotency (DLQ row already has a row → skip)
 *   - LLM fallback (records `scanner_error` with reason)
 *   - happy path (proposal + validation enqueue)
 *   - kill-switch flip mid-scan (master gate re-check between candidates)
 *
 * Plus three lifecycle pins: scanner registration default, env override,
 * malformed env warn-fallback.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@janusly/data/src/failureClusterRepo", () => ({
  queryFailureSamples: vi.fn(),
}));

vi.mock("@janusly/engine/src/cluster-failures", () => ({
  clusterFailureSamples: vi.fn(),
}));

vi.mock("@janusly/data/src/orgConfigRepo", () => ({
  getOrgConfigSnapshot: vi.fn(),
}));

vi.mock("@janusly/engine/src/auto-healing-consent", () => ({
  isAutoHealingAllowed: vi.fn(),
}));

vi.mock("@janusly/engine/src/budget", () => ({
  checkBudget: vi.fn(),
}));

vi.mock("@janusly/data/src/autoHealingRepo", () => ({
  countRecentAttemptsBySignature: vi.fn(),
  createDiagnosis: vi.fn(),
  getDeadLetterIdsWithExistingRun: vi.fn(),
  recordImmediateDecline: vi.fn(),
  recordProposal: vi.fn(),
  recordScannerFailure: vi.fn(),
  recordValidationStarted: vi.fn(),
}));

vi.mock("@janusly/ai", () => ({
  getLlmClient: vi.fn(() => ({})),
  suggestWorkflowPatch: vi.fn(),
}));

vi.mock("@janusly/engine/src/adapters/dlq-replay", () => ({
  DLQReplayAdapter: class {
    async replayDeadLetterAsValidation() {
      return { runId: "validation-run-1" };
    }
    async replayDeadLetter() {
      return undefined;
    }
  },
}));

const hoisted = vi.hoisted(() => ({
  selectFromMock: vi.fn(),
  upsertJobSchedulerMock: vi.fn(),
}));

vi.mock("@janusly/db", () => ({
  db: {
    select: vi.fn(() => ({ from: hoisted.selectFromMock })),
  },
  deadLetters: { id: "id_col", orgId: "org_id_col", runId: "run_id_col" },
  orgConfigs: { key: "key_col", orgId: "org_id_col", valueJson: "value_json_col" },
  runs: { id: "id_col", orgId: "org_id_col" },
}));

vi.mock("./auto-healing-queue", () => ({
  autoHealingQueue: { upsertJobScheduler: hoisted.upsertJobSchedulerMock },
  AUTO_HEALING_QUEUE_NAME: "auto-healing-system",
}));

const selectFromMock = hoisted.selectFromMock;
const upsertJobSchedulerMock = hoisted.upsertJobSchedulerMock;

import {
  AUTO_HEALING_SCAN_JOB_ID,
  AUTO_HEALING_SCAN_JOB_NAME,
  DEFAULT_AUTO_HEALING_SCAN_CRON,
  registerAutoHealingScannerScheduler,
  runOrgScan,
  handleAutoHealingScanTrigger,
} from "./auto-healing-scanner";
import { isAutoHealingAllowed } from "@janusly/engine/src/auto-healing-consent";
import { queryFailureSamples } from "@janusly/data/src/failureClusterRepo";
import { clusterFailureSamples } from "@janusly/engine/src/cluster-failures";
import { getOrgConfigSnapshot } from "@janusly/data/src/orgConfigRepo";
import { checkBudget } from "@janusly/engine/src/budget";
import {
  countRecentAttemptsBySignature,
  createDiagnosis,
  getDeadLetterIdsWithExistingRun,
  recordImmediateDecline,
  recordProposal,
  recordScannerFailure,
  recordValidationStarted,
} from "@janusly/data/src/autoHealingRepo";
import { suggestWorkflowPatch } from "@janusly/ai";

const isAllowedMock = vi.mocked(isAutoHealingAllowed);
const samplesMock = vi.mocked(queryFailureSamples);
const clusterMock = vi.mocked(clusterFailureSamples);
const snapshotMock = vi.mocked(getOrgConfigSnapshot);
const budgetMock = vi.mocked(checkBudget);
const countMock = vi.mocked(countRecentAttemptsBySignature);
const existingMock = vi.mocked(getDeadLetterIdsWithExistingRun);
const diagnoseMock = vi.mocked(createDiagnosis);
const proposeMock = vi.mocked(recordProposal);
const validationStartedMock = vi.mocked(recordValidationStarted);
const immediateDeclineMock = vi.mocked(recordImmediateDecline);
const scannerFailMock = vi.mocked(recordScannerFailure);
const suggestMock = vi.mocked(suggestWorkflowPatch);

function buildHttpWorkflow() {
  return {
    id: "wf-1",
    nodes: [
      {
        id: "n-1",
        type: "http",
        config: { url: "https://example.com/x", method: "GET" },
      },
    ],
    edges: [],
  };
}

function buildCluster() {
  return {
    signature: "HTTP 500 on http node",
    category: "http",
    frequency: 3,
    affectedWorkflows: [],
    firstSeen: "2026-05-21T00:00:00Z",
    lastSeen: "2026-05-21T01:00:00Z",
    suggestedOwner: "workflow_author",
    samples: [
      { source: "dead_letter", id: "dlq-1", runId: "run-1" },
      { source: "dead_letter", id: "dlq-2", runId: "run-2" },
    ],
  } as never;
}

function setupHappyPathDb() {
  // db.select for the DLQ row fetch in loadDeadLetter:
  // .from(deadLetters).innerJoin(runs).where(...).limit(1).
  const limit = vi.fn().mockResolvedValue([
    {
      runId: "run-1",
      nodeId: "n-1",
      workflowJson: buildHttpWorkflow(),
      nodeJson: { id: "n-1", type: "http" },
      errorJson: { error: "boom" },
    },
  ]);
  const where = vi.fn(() => ({ limit }));
  const innerJoin = vi.fn(() => ({ where }));
  selectFromMock.mockReturnValue({ innerJoin });
  return { limit, where, innerJoin };
}

beforeEach(() => {
  selectFromMock.mockReset();
  upsertJobSchedulerMock.mockReset().mockResolvedValue(undefined);
  isAllowedMock.mockReset().mockResolvedValue({ allowed: true });
  samplesMock.mockReset().mockResolvedValue([]);
  clusterMock.mockReset().mockReturnValue([]);
  snapshotMock.mockReset().mockResolvedValue({
    autoHealing: { enabled: true, autoApply: false, maxAttemptsPerSignature: 3, loopWindowDays: 14 },
  } as never);
  budgetMock.mockReset().mockResolvedValue({ allowed: true } as never);
  countMock.mockReset().mockResolvedValue(0);
  existingMock.mockReset().mockResolvedValue(new Set());
  diagnoseMock.mockReset().mockResolvedValue("diag-1");
  proposeMock.mockReset();
  validationStartedMock.mockReset();
  immediateDeclineMock.mockReset();
  scannerFailMock.mockReset();
  suggestMock.mockReset();
  delete process.env.JANUSLY_AUTO_HEALING_ENABLED;
  delete process.env.JANUSLY_AUTO_HEALING_SCAN_CRON;
});

// ─── Scheduler registration ─────────────────────────────────────────────────

describe("registerAutoHealingScannerScheduler", () => {
  it("registers the default cron when env is empty", async () => {
    await expect(registerAutoHealingScannerScheduler({})).resolves.toBe(true);
    expect(upsertJobSchedulerMock).toHaveBeenCalledWith(
      AUTO_HEALING_SCAN_JOB_ID,
      { pattern: DEFAULT_AUTO_HEALING_SCAN_CRON },
      { name: AUTO_HEALING_SCAN_JOB_NAME, data: {} },
    );
  });

  it("respects the env override when JANUSLY_AUTO_HEALING_SCAN_CRON is set", async () => {
    await expect(
      registerAutoHealingScannerScheduler({ JANUSLY_AUTO_HEALING_SCAN_CRON: "*/15 * * * *" }),
    ).resolves.toBe(true);
    expect(upsertJobSchedulerMock).toHaveBeenCalledWith(
      AUTO_HEALING_SCAN_JOB_ID,
      { pattern: "*/15 * * * *" },
      { name: AUTO_HEALING_SCAN_JOB_NAME, data: {} },
    );
  });

  it("warn-logs and falls back to the default when env carries a malformed cron", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        registerAutoHealingScannerScheduler({ JANUSLY_AUTO_HEALING_SCAN_CRON: "totally-not-a-cron" }),
      ).resolves.toBe(true);
      expect(warn).toHaveBeenCalled();
      expect(upsertJobSchedulerMock).toHaveBeenCalledWith(
        AUTO_HEALING_SCAN_JOB_ID,
        { pattern: DEFAULT_AUTO_HEALING_SCAN_CRON },
        { name: AUTO_HEALING_SCAN_JOB_NAME, data: {} },
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("never throws when upsertJobScheduler rejects (Redis blip → returns false)", async () => {
    upsertJobSchedulerMock.mockRejectedValueOnce(new Error("redis down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(registerAutoHealingScannerScheduler({})).resolves.toBe(false);
    } finally {
      errSpy.mockRestore();
    }
  });
});

// ─── Trigger handler ────────────────────────────────────────────────────────

describe("handleAutoHealingScanTrigger", () => {
  it("returns immediately when JANUSLY_AUTO_HEALING_ENABLED is not 'true'", async () => {
    await handleAutoHealingScanTrigger();
    expect(selectFromMock).not.toHaveBeenCalled();
  });

  it("walks every org with autoHealing.enabled === true", async () => {
    process.env.JANUSLY_AUTO_HEALING_ENABLED = "true";
    // db.select for listEnabledOrgIds: .from(orgConfigs).where(...)
    const where = vi.fn().mockResolvedValue([{ orgId: "org-1" }, { orgId: "org-2" }]);
    selectFromMock.mockReturnValueOnce({ where });
    isAllowedMock.mockResolvedValue({ allowed: false, reason: "tenant_disabled", message: "" });
    await handleAutoHealingScanTrigger();
    expect(isAllowedMock).toHaveBeenCalledTimes(2);
  });
});

// ─── runOrgScan: per-AC gates ───────────────────────────────────────────────

describe("runOrgScan — gates and lifecycle", () => {
  it("skips silently when the master gate is off (feature-flag rejection AC)", async () => {
    isAllowedMock.mockResolvedValueOnce({ allowed: false, reason: "tenant_disabled", message: "off" });
    await runOrgScan("org-1");
    expect(samplesMock).not.toHaveBeenCalled();
    expect(immediateDeclineMock).not.toHaveBeenCalled();
  });

  it("records loop_breaker_tripped when the attempt count is at the cap", async () => {
    samplesMock.mockResolvedValueOnce([{ source: "dead_letter", id: "dlq-1", runId: "run-1" }] as never);
    clusterMock.mockReturnValueOnce([buildCluster()]);
    countMock.mockResolvedValueOnce(3);

    await runOrgScan("org-1");

    expect(immediateDeclineMock).toHaveBeenCalledWith(
      "org-1",
      "dlq-1",
      "HTTP 500 on http node",
      3,
      "loop_breaker_tripped",
    );
    expect(diagnoseMock).not.toHaveBeenCalled();
  });

  it("records budget_exceeded when the budget check returns disallowed", async () => {
    samplesMock.mockResolvedValueOnce([{ source: "dead_letter", id: "dlq-1", runId: "run-1" }] as never);
    clusterMock.mockReturnValueOnce([buildCluster()]);
    budgetMock.mockResolvedValueOnce({ allowed: false } as never);

    await runOrgScan("org-1");

    expect(immediateDeclineMock).toHaveBeenCalledWith(
      "org-1",
      "dlq-1",
      "HTTP 500 on http node",
      0,
      "budget_exceeded",
    );
    expect(diagnoseMock).not.toHaveBeenCalled();
  });

  it("skips DLQ rows that already have an auto_healing_runs row (idempotency)", async () => {
    samplesMock.mockResolvedValueOnce([{ source: "dead_letter", id: "dlq-1", runId: "run-1" }] as never);
    clusterMock.mockReturnValueOnce([buildCluster()]);
    existingMock.mockResolvedValueOnce(new Set(["dlq-1"]));

    await runOrgScan("org-1");

    expect(diagnoseMock).not.toHaveBeenCalled();
    expect(immediateDeclineMock).not.toHaveBeenCalled();
  });

  it("records scanner_error reason when the LLM helper returns fallback", async () => {
    samplesMock.mockResolvedValueOnce([{ source: "dead_letter", id: "dlq-1", runId: "run-1" }] as never);
    clusterMock.mockReturnValueOnce([buildCluster()]);
    setupHappyPathDb();
    suggestMock.mockResolvedValueOnce({
      mode: "fallback",
      suggestions: [{ patchedConfig: {}, rationale: "n/a", approachLabel: "other", confidence: 0 }],
      aiError: "rate_limited",
    } as never);

    await runOrgScan("org-1");

    expect(diagnoseMock).toHaveBeenCalled();
    expect(scannerFailMock).toHaveBeenCalledWith(
      "org-1",
      "dlq-1",
      "HTTP 500 on http node",
      0,
      expect.stringContaining("llm_fallback"),
    );
    expect(proposeMock).not.toHaveBeenCalled();
  });

  it("happy path: diagnoses, proposes, records validation started (AI mode)", async () => {
    samplesMock.mockResolvedValueOnce([{ source: "dead_letter", id: "dlq-1", runId: "run-1" }] as never);
    clusterMock.mockReturnValueOnce([buildCluster()]);
    setupHappyPathDb();
    suggestMock.mockResolvedValueOnce({
      mode: "ai",
      suggestions: [
        {
          patchedConfig: { url: "https://example.com/y" }, // shallow merge into http config
          rationale: "fix url",
          approachLabel: "fix_url",
          confidence: 85,
        },
      ],
    } as never);

    await runOrgScan("org-1");

    expect(diagnoseMock).toHaveBeenCalled();
    expect(proposeMock).toHaveBeenCalledWith("diag-1", expect.objectContaining({
      approachLabel: "fix_url",
      confidence: 85,
    }));
    expect(validationStartedMock).toHaveBeenCalledWith("diag-1", "validation-run-1");
  });

  it("re-checks the master gate between candidates (kill-switch flip mid-scan)", async () => {
    samplesMock.mockResolvedValueOnce([
      { source: "dead_letter", id: "dlq-1", runId: "run-1" },
      { source: "dead_letter", id: "dlq-2", runId: "run-2" },
    ] as never);
    const base = buildCluster() as Record<string, unknown>;
    const clusterA = { ...base, signature: "sig-A", samples: [{ source: "dead_letter", id: "dlq-1", runId: "run-1" }] };
    const clusterB = { ...base, signature: "sig-B", samples: [{ source: "dead_letter", id: "dlq-2", runId: "run-2" }] };
    clusterMock.mockReturnValueOnce([clusterA, clusterB] as never);
    setupHappyPathDb();
    suggestMock.mockResolvedValueOnce({
      mode: "ai",
      suggestions: [{ patchedConfig: { url: "https://example.com/y" }, rationale: "", approachLabel: "fix_url", confidence: 85 }],
    } as never);

    // First gate call passes; second (between candidates) flips to disallowed.
    isAllowedMock.mockResolvedValueOnce({ allowed: true });
    isAllowedMock.mockResolvedValueOnce({ allowed: false, reason: "process_disabled", message: "" });

    await runOrgScan("org-1");

    // Only the FIRST candidate gets a proposal — the second one is short-circuited.
    expect(proposeMock).toHaveBeenCalledTimes(1);
  });
});

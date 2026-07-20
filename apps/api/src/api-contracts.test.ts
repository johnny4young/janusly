/**
 * Behavioral parity checks between pure engine results and the stable API
 * schemas. These keep the OpenAPI/runtime boundary aligned with the values the
 * workflow preflight and health handlers actually produce.
 */

import { describe, expect, it } from "vitest";

import { computeWorkflowHealth } from "@janusly/engine/src/workflow-health";
import { clusterFailureSamples } from "@janusly/engine/src/cluster-failures";
import { buildRunExplainReport } from "@janusly/engine/src/run-explain-report";
import { checkWorkflowReadiness } from "@janusly/engine/src/workflow-readiness";
import { validateWorkflow } from "@janusly/engine/src/workflow-validation";
import { WorkflowSchema } from "@janusly/shared";

import {
  checkWorkflowReadinessContract,
  getWorkflowHealthContract,
  getRunExplainReportContract,
  listDeadLettersContract,
  listFailureClustersContract,
  replayDeadLetterContract,
  rollbackWorkflowContract,
  saveWorkflowContract,
  validateWorkflowContract,
} from "./api-contracts";

const workflow = WorkflowSchema.parse({
  dslVersion: "1.0",
  id: "contract-smoke",
  nodes: [{ id: "start", type: "noop", config: {} }],
  edges: [],
});

describe("run-explanation stable contract", () => {
  it("requires an explicit JSON format and rejects download-only variants", () => {
    const querySchema = getRunExplainReportContract.request.query;
    expect(getRunExplainReportContract.errorCodes).toContain("invalid_input");
    expect(querySchema.safeParse({ runId: "run-1", format: "json" }).success).toBe(true);
    expect(querySchema.safeParse({ runId: "run-1" }).success).toBe(false);
    expect(querySchema.safeParse({ runId: "run-1", format: "markdown" }).success).toBe(false);
    expect(querySchema.safeParse({ runId: "run-1", format: "json", download: "1" }).success).toBe(false);
  });

  it("accepts a real bounded engine report with failure evidence", () => {
    const report = buildRunExplainReport({
      run: {
        id: "run-1",
        status: "failed",
        workflowVersionId: "version-3",
        createdAt: "2026-07-20T12:00:00.000Z",
      },
      runNodes: [{
        nodeId: "http-1",
        status: "failed",
        attempts: 3,
        startedAt: "2026-07-20T12:00:01.000Z",
        finishedAt: "2026-07-20T12:00:04.000Z",
        stateJson: { nodeType: "http" },
        errorJson: { message: "Request timed out after 10 seconds" },
      }],
      runEvents: [{
        id: "event-1",
        nodeId: "http-1",
        type: "node.failed",
        createdAt: "2026-07-20T12:00:04.000Z",
      }],
      recoveryAudit: {
        createdAt: "2026-07-20T12:05:00.000Z",
        metadata: {
          mode: "ai",
          envelopeKind: "http",
          patchStyle: "config_only",
          topApproachLabel: "raise_timeout",
          suggestionsCount: 2,
        },
      },
    });

    expect(getRunExplainReportContract.response.safeParse(report.json).success).toBe(true);
  });

  it("rejects reports that exceed the deterministic timeline cap", () => {
    const report = buildRunExplainReport({
      run: { id: "run-1", status: "succeeded" },
      runNodes: [],
      runEvents: [],
      recoveryAudit: null,
    }).json;
    const oversized = {
      ...report,
      timeline: Array.from({ length: 51 }, (_, index) => ({
        at: null,
        nodeId: null,
        type: `event.${index}`,
      })),
    };

    expect(getRunExplainReportContract.response.safeParse(oversized).success).toBe(false);
  });
});

describe("workflow stable contracts", () => {
  it("accepts incomplete object candidates so validation can report their issues", () => {
    const bodySchema = validateWorkflowContract.request.body;
    expect(bodySchema.safeParse({ nodes: "not-an-array" }).success).toBe(true);
    expect(bodySchema.safeParse(null).success).toBe(false);
    expect(bodySchema.safeParse([]).success).toBe(false);
  });

  it("accepts real structural validation results for valid and invalid drafts", () => {
    expect(validateWorkflowContract.response.safeParse(validateWorkflow(workflow)).success).toBe(true);
    expect(validateWorkflowContract.response.safeParse(validateWorkflow({ nodes: [], edges: [] })).success).toBe(true);
  });

  it("accepts the engine readiness result", () => {
    const result = checkWorkflowReadiness(workflow);
    expect(checkWorkflowReadinessContract.response.safeParse(result).success).toBe(true);
  });

  it("accepts the complete health result including a null SLO block", () => {
    const readiness = checkWorkflowReadiness(workflow);
    const result = computeWorkflowHealth({
      workflow,
      readiness,
      signals: {
        totalRuns: 0,
        successCount: 0,
        failureCount: 0,
        retryCount: 0,
        dlqOpenCount: 0,
        p95LatencyMs: null,
        totalCostUsd: 0,
        totalTokens: 0,
        versionCount: 1,
      },
      slo: null,
    });
    expect(getWorkflowHealthContract.response.safeParse(result).success).toBe(true);
  });

  it("keeps stable save input explicit while allowing bounded upstream subscriptions", () => {
    const bodySchema = saveWorkflowContract.request.body;
    expect(bodySchema.safeParse({ ...workflow, upstreamHealthSources: ["github"] }).success).toBe(true);
    expect(bodySchema.safeParse({ ...workflow, unexpected: true }).success).toBe(false);
    expect(saveWorkflowContract.response.safeParse({
      workflowId: "contract-smoke",
      versionId: "version-2",
      version: 2,
    }).success).toBe(true);
  });

  it("requires both rollback identifiers and validates its version response", () => {
    const bodySchema = rollbackWorkflowContract.request.body;
    expect(bodySchema.safeParse({ workflowId: "contract-smoke", sourceVersionId: "version-1" }).success).toBe(true);
    expect(bodySchema.safeParse({ workflowId: "contract-smoke" }).success).toBe(false);
    expect(rollbackWorkflowContract.response.safeParse({
      workflowId: "contract-smoke",
      versionId: "version-3",
      version: 3,
      sourceVersion: 1,
    }).success).toBe(true);
  });
});

describe("DLQ stable contracts", () => {
  const summary = {
    id: "dl-1",
    orgId: "org-1",
    runId: "run-1",
    nodeId: "http-1",
    attempt: 2,
    errorJson: { message: "Request timed out" },
    status: "open",
    replayedAt: null,
    createdAt: "2026-07-19T12:00:00.000Z",
    nodeType: "http",
    workflowName: "Invoice delivery",
    recovery: {
      id: "recovery-1",
      owner: "operator-1",
      severity: "p1",
      status: "open",
      slaTargetAt: "2026-07-19T12:30:00.000Z",
      resolutionReason: null,
      comments: [{ body: "Investigating" }],
      workflowId: "workflow-1",
      metadataWorkflowId: "workflow-1",
      occurrenceCount: 3,
      lastOccurredAt: "2026-07-19T12:05:00.000Z",
    },
  };

  it("accepts only the bounded dead-letter summary projection", () => {
    expect(listDeadLettersContract.response.safeParse([summary]).success).toBe(true);
    expect(listDeadLettersContract.response.safeParse([{
      ...summary,
      workflowJson: { nodes: Array.from({ length: 1_000 }, () => ({ id: "large" })) },
    }]).success).toBe(false);
  });

  it("keeps the stable list query separate from the legacy detail query", () => {
    const querySchema = listDeadLettersContract.request.query;
    expect(querySchema.safeParse({ status: "open", severity: "p1", sort: "sla", limit: "25" }).success).toBe(true);
    expect(querySchema.safeParse({ id: "dl-1" }).success).toBe(false);
    expect(querySchema.safeParse({ limit: "201" }).success).toBe(false);
  });

  it("accepts real scrubbed failure-cluster output with recurrence evidence", () => {
    const clusters = clusterFailureSamples([{
      source: "dead_letter",
      id: "dl-1",
      workflowId: "workflow-1",
      workflowName: "Invoice delivery",
      runId: "run-1",
      nodeId: "http-1",
      nodeType: "http",
      errorJson: { message: "Request timed out after 10 seconds" },
      createdAt: new Date("2026-07-19T12:00:00.000Z"),
    }]).map((cluster) => ({ ...cluster, recurredAfterRecovery: false }));

    expect(listFailureClustersContract.response.safeParse({
      clusters,
      totalSamples: 1,
      windowDays: 30,
    }).success).toBe(true);
    expect(listFailureClustersContract.request.query.safeParse({ windowDays: "91" }).success).toBe(false);
  });

  it("requires canonical dead-letter identity and paired playbook evidence for replay", () => {
    const bodySchema = replayDeadLetterContract.request.body;
    expect(bodySchema.safeParse({ deadLetterId: "dl-1" }).success).toBe(true);
    expect(bodySchema.safeParse({
      deadLetterId: "dl-1",
      recoveryPlaybookId: "playbook-1",
      recoveryValidationRunId: "validation-1",
    }).success).toBe(true);
    expect(bodySchema.safeParse({ runId: "run-1", nodeId: "http-1" }).success).toBe(false);
    expect(bodySchema.safeParse({ deadLetterId: "dl-1", recoveryPlaybookId: "playbook-1" }).success).toBe(false);
    expect(replayDeadLetterContract.response.safeParse({ ok: true }).success).toBe(true);
  });
});

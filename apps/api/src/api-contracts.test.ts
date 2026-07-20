/**
 * Behavioral parity checks between pure engine results and the stable API
 * schemas. These keep the OpenAPI/runtime boundary aligned with the values the
 * workflow preflight and health handlers actually produce.
 */

import { describe, expect, it } from "vitest";

import { computeWorkflowHealth } from "@janusly/engine/src/workflow-health";
import { checkWorkflowReadiness } from "@janusly/engine/src/workflow-readiness";
import { validateWorkflow } from "@janusly/engine/src/workflow-validation";
import { WorkflowSchema } from "@janusly/shared";

import {
  checkWorkflowReadinessContract,
  getWorkflowHealthContract,
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

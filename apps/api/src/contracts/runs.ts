/**
 * Side-effect-free stable API contracts for the runs domain.
 * Imported by route registries and the pure OpenAPI manifest.
 */

import { WorkflowSchema } from "@janusly/shared";
import { V1_READ_PATHS, V1_WRITE_PATHS } from "@janusly/shared/src/api-contract";
import { runStatusValues } from "@janusly/shared/src/status";
import { z } from "zod";

import type { ApiRouteContract } from "../api-contract-types";
import {
  JsonValueSchema,
  KeysetCursorSchema,
  MCP_WRITE_ERROR_CODES,
  PositiveLimitSchema,
  RunDetailQuerySchema,
  RunDetailSchema,
  RunSummarySchema,
  RunUsageSchema,
} from "./schemas";

export const listRunsContract = {
  operationId: "listRuns",
  path: V1_READ_PATHS.runs,
  summary: "List tenant runs with optional workflow, status, and run-kind filtering",
  tags: ["Runs"],
  request: {
    query: z.object({
      limit: PositiveLimitSchema.optional(),
      workflowId: z.string().trim().min(1).optional(),
      status: z.enum(runStatusValues).optional(),
      runKind: z.enum(["production", "validation"]).optional(),
      before: KeysetCursorSchema.optional(),
    }).strict(),
  },
  response: z.array(RunSummarySchema),
  errorCodes: ["invalid_input"],
} satisfies ApiRouteContract;

export const getRunContract = {
  operationId: "getRun",
  path: V1_READ_PATHS.run,
  summary: "Get a run, its nodes, and a paginated event page",
  tags: ["Runs"],
  request: { query: RunDetailQuerySchema },
  response: RunDetailSchema,
  errorCodes: ["invalid_input", "runs_run_id_required", "runs_forbidden"],
} satisfies ApiRouteContract;

export const getRunStatusContract = {
  operationId: "getRunStatus",
  path: V1_READ_PATHS.runStatus,
  summary: "Poll the latest run state and event page",
  tags: ["Runs"],
  request: {
    query: RunDetailQuerySchema.omit({ eventsCursor: true }),
  },
  response: RunDetailSchema,
  errorCodes: ["invalid_input", "runs_run_id_required", "runs_forbidden"],
} satisfies ApiRouteContract;

export const getRunUsageContract = {
  operationId: "getRunUsage",
  path: V1_READ_PATHS.runUsage,
  summary: "Get a bounded resource-usage projection for one run",
  tags: ["Runs"],
  request: {
    query: z.object({ runId: z.string().trim().min(1) }).strict(),
  },
  response: RunUsageSchema,
  errorCodes: ["invalid_input", "runs_run_id_required", "runs_forbidden"],
} satisfies ApiRouteContract;

export const redriveRunContract = {
  operationId: "redriveRun",
  path: V1_WRITE_PATHS.redriveRun,
  summary: "Continue a failed saved-workflow run on a selected workflow version",
  tags: ["Runs"],
  request: {
    body: z.object({
      runId: z.string().trim().min(1).max(256),
      nodeId: z.string().trim().min(1).max(256).optional(),
      workflowVersionId: z.string().trim().min(1).max(256).optional(),
    }).strict(),
  },
  response: z.object({ runId: z.string().min(1) }),
  errorCodes: [
    "invalid_input",
    "runs_run_id_required",
    "runs_forbidden",
    "runs_redrive_source_not_failed",
    "runs_redrive_node_not_failed",
    "runs_redrive_node_ambiguous",
    "runs_redrive_requires_saved_workflow",
    "runs_redrive_workflow_paused",
    "runs_redrive_version_not_found",
    "runs_redrive_version_invalid",
    "runs_redrive_node_missing_in_version",
    "runs_redrive_predecessor_not_succeeded",
    "runs_not_production_ready",
    "workflow_not_found",
    ...MCP_WRITE_ERROR_CODES,
  ],
} satisfies ApiRouteContract;

export const startRunContract = {
  operationId: "startRun",
  path: V1_WRITE_PATHS.startRun,
  summary: "Start a workflow run",
  tags: ["Runs"],
  request: {
    body: z.object({
      workflow: WorkflowSchema,
      input: JsonValueSchema.optional(),
      forceRunDuringPause: z.boolean().optional(),
    }).strict(),
  },
  response: z.object({
    runId: z.string().min(1),
    parentWaitingMetadata: JsonValueSchema.optional(),
  }),
  errorCodes: [
    "invalid_input",
    "runs_validation_failed",
    "runs_not_production_ready",
    "runs_adhoc_disabled",
    "runs_input_validation_failed",
    "upstream_degraded",
    "workflow_circuit_breaker_paused",
    ...MCP_WRITE_ERROR_CODES,
  ],
} satisfies ApiRouteContract;

export const resumeRunContract = {
  operationId: "resumeRun",
  path: V1_WRITE_PATHS.resumeRun,
  summary: "Resume a waiting run node",
  tags: ["Runs"],
  request: {
    body: z.object({
      runId: z.string().trim().min(1).max(256),
      nodeId: z.string().trim().min(1).max(256),
      input: JsonValueSchema.optional(),
      resumeToken: z.string().min(1).max(8192).optional(),
    }).strict(),
  },
  response: z.object({ resumed: z.literal(true) }),
  errorCodes: [
    "invalid_input",
    "runs_run_id_and_node_id_required",
    "runs_forbidden",
    "runs_input_validation_failed",
    "runs_resume_conflict",
    "runs_resume_token_required",
    "runs_invalid_resume_token",
    ...MCP_WRITE_ERROR_CODES,
  ],
} satisfies ApiRouteContract;

export const cancelRunContract = {
  operationId: "cancelRun",
  path: V1_WRITE_PATHS.cancelRun,
  summary: "Cancel an in-flight run",
  tags: ["Runs"],
  request: {
    body: z.object({
      runId: z.string().trim().min(1).max(256),
      reason: z.string().trim().min(1).max(1000).optional(),
    }).strict(),
  },
  response: z.object({
    runId: z.string().min(1),
    status: z.literal("cancelled"),
  }),
  errorCodes: [
    "invalid_input",
    "runs_run_id_required",
    "runs_run_not_found",
    "runs_forbidden",
    "runs_already_terminal",
    ...MCP_WRITE_ERROR_CODES,
  ],
} satisfies ApiRouteContract;

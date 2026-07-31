/**
 * Side-effect-free stable API contracts for the workflows domain.
 * Imported by route registries and the pure OpenAPI manifest.
 */

import { V1_READ_PATHS, V1_WRITE_PATHS } from "@janusly/shared/src/api-contract";
import { z } from "zod";

import type { ApiRouteContract } from "../api-contract-types";
import {
  IsoDateSchema,
  KeysetCursorSchema,
  MCP_WRITE_ERROR_CODES,
  PositiveLimitSchema,
  ReadinessResultSchema,
  RollbackWorkflowBodySchema,
  SaveWorkflowBodySchema,
  SavedWorkflowVersionSchema,
  WorkflowCandidateBodySchema,
  WorkflowHealthSchema,
  WorkflowListRowSchema,
  WorkflowValidationResultSchema,
  WorkflowVersionSchema,
} from "./schemas";

export const validateWorkflowContract = {
  operationId: "validateWorkflow",
  path: V1_WRITE_PATHS.validateWorkflow,
  summary: "Validate a workflow draft without persisting it",
  tags: ["Workflows"],
  request: { body: WorkflowCandidateBodySchema },
  response: WorkflowValidationResultSchema,
  errorCodes: ["invalid_input"],
} satisfies ApiRouteContract;

export const checkWorkflowReadinessContract = {
  operationId: "checkWorkflowReadiness",
  path: V1_WRITE_PATHS.workflowReadiness,
  summary: "Check a workflow draft's production readiness",
  tags: ["Workflows"],
  request: { body: WorkflowCandidateBodySchema },
  response: ReadinessResultSchema,
  errorCodes: ["invalid_input"],
} satisfies ApiRouteContract;

export const getWorkflowHealthContract = {
  operationId: "getWorkflowHealth",
  path: V1_READ_PATHS.workflowHealth,
  summary: "Get the latest workflow health score and signals",
  tags: ["Workflows"],
  request: {
    query: z.object({
      workflowId: z.string().trim().min(1).max(256),
    }).strict(),
  },
  response: WorkflowHealthSchema,
  errorCodes: [
    "invalid_input",
    "workflows_workflow_id_required",
    "workflow_not_found",
    "workflows_no_versions",
    "workflows_version_malformed",
  ],
} satisfies ApiRouteContract;

export const saveWorkflowContract = {
  operationId: "saveWorkflow",
  path: V1_WRITE_PATHS.saveWorkflow,
  summary: "Save a validated workflow as a new immutable version",
  tags: ["Workflows"],
  request: { body: SaveWorkflowBodySchema },
  response: SavedWorkflowVersionSchema,
  errorCodes: [
    "invalid_input",
    "workflow_not_found",
    "workflows_validation_failed",
    "workflows_upstream_health_sources_invalid",
    "workflows_save_conflict",
    ...MCP_WRITE_ERROR_CODES,
  ],
} satisfies ApiRouteContract;

export const rollbackWorkflowContract = {
  operationId: "rollbackWorkflow",
  path: V1_WRITE_PATHS.rollbackWorkflow,
  summary: "Append a prior workflow snapshot as the new latest version",
  tags: ["Workflows"],
  request: { body: RollbackWorkflowBodySchema },
  response: SavedWorkflowVersionSchema.extend({
    sourceVersion: z.number().int().positive(),
  }),
  errorCodes: [
    "invalid_input",
    "workflow_not_found",
    "workflows_rollback_ids_required",
    "workflows_source_version_not_found",
    "workflows_version_malformed",
    "workflows_rollback_conflict",
    ...MCP_WRITE_ERROR_CODES,
  ],
} satisfies ApiRouteContract;

export const listWorkflowsContract = {
  operationId: "listWorkflows",
  path: V1_READ_PATHS.workflows,
  summary: "List active workflows with run summaries",
  tags: ["Workflows"],
  request: {
    query: z.object({
      limit: PositiveLimitSchema.optional(),
      tag: z.array(z.string().trim().min(1).max(40)).max(20).optional()
        .describe("Repeatable tag filter; all supplied tags must match."),
      folder: z.string().trim().min(1).max(60).optional(),
      q: z.string().trim().min(1).max(100).optional()
        .describe("Case-insensitive workflow name or ID search."),
      before: KeysetCursorSchema.optional(),
    }).strict(),
    repeatableQueryParams: ["tag"],
  },
  response: z.array(WorkflowListRowSchema),
  errorCodes: ["invalid_input"],
} satisfies ApiRouteContract;

export const getSchedulePreviewContract = {
  operationId: "getSchedulePreview",
  path: V1_READ_PATHS.schedulePreview,
  summary: "Preview the next three fires for a five-field cron expression",
  tags: ["Workflows"],
  request: {
    query: z.object({
      cron: z.string().trim().min(1).max(100),
    }).strict(),
  },
  response: z.discriminatedUnion("valid", [
    z.object({
      valid: z.literal(true),
      nextFires: z.tuple([IsoDateSchema, IsoDateSchema, IsoDateSchema]),
    }),
    z.object({
      valid: z.literal(false),
      nextFires: z.tuple([]),
    }),
  ]),
  errorCodes: ["invalid_input"],
} satisfies ApiRouteContract;

export const listWorkflowVersionsContract = {
  operationId: "listWorkflowVersions",
  path: V1_READ_PATHS.workflowVersions,
  summary: "List immutable versions for an active workflow",
  tags: ["Workflows"],
  request: {
    query: z.object({ workflowId: z.string().trim().min(1) }).strict(),
  },
  response: z.array(WorkflowVersionSchema),
  errorCodes: ["invalid_input", "workflows_workflow_id_required", "workflow_not_found"],
} satisfies ApiRouteContract;

export const getLatestWorkflowVersionContract = {
  operationId: "getLatestWorkflowVersion",
  path: V1_READ_PATHS.latestWorkflowVersion,
  summary: "Get the latest immutable version for an active workflow",
  tags: ["Workflows"],
  request: {
    query: z.object({ workflowId: z.string().trim().min(1) }).strict(),
  },
  response: WorkflowVersionSchema.nullable(),
  errorCodes: ["invalid_input", "workflows_workflow_id_required", "workflow_not_found"],
} satisfies ApiRouteContract;

export const resumeWorkflowContract = {
  operationId: "resumeWorkflow",
  path: V1_WRITE_PATHS.resumeWorkflow,
  summary: "Resume a workflow paused by its recovery circuit breaker",
  tags: ["Workflows"],
  request: {
    path: z.object({
      workflowId: z.string().trim().min(1).max(512),
    }).strict(),
  },
  response: z.object({
    ok: z.literal(true),
    workflowId: z.string().min(1),
    status: z.literal("active"),
    backfilled: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
  }),
  errorCodes: [
    "invalid_input",
    "workflows_workflow_id_required",
    "workflow_not_found",
    "workflow_not_circuit_breaker_paused",
    ...MCP_WRITE_ERROR_CODES,
  ],
} satisfies ApiRouteContract;

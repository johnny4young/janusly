/**
 * Zod contracts for the first stable `/v1` API lane.
 *
 * Used by the recovery, workflow, and run route registries. These schemas
 * describe the JSON wire representation (dates are ISO strings, never Date
 * objects) and are reused for runtime output validation and OpenAPI emission.
 */

import { WorkflowSchema } from "@janusly/shared";
import { V1_READ_PATHS } from "@janusly/shared/src/api-contract";
import { nodeStatusValues, runStatusValues } from "@janusly/shared/src/status";
import { z } from "zod";

import type { ApiContractRouteDescriptor, ApiRouteContract } from "./api-contract-types";

const IsoDateSchema = z.iso.datetime({ offset: true });
const NullableIsoDateSchema = IsoDateSchema.nullable();
const JsonValueSchema = z.unknown();

const PositiveLimitSchema = z.coerce.number().int().min(1).max(200)
  .describe("Maximum number of rows to return (1-200).");

const KeysetCursorSchema = z.string().min(3).max(512)
  .describe("Opaque `<iso>|<id>` keyset cursor returned by the preceding page.");

const WorkflowListRowSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  createdBy: z.string().nullable(),
  createdAt: NullableIsoDateSchema,
  lastRunStatus: z.string().nullable(),
  runCount: z.number().int().nonnegative(),
  status: z.string(),
  pausedReason: z.string().nullable(),
  tags: z.array(z.string()),
  folder: z.string().nullable(),
  deletedAt: NullableIsoDateSchema,
});

const WorkflowVersionSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  workflowId: z.string(),
  version: z.number().int().positive(),
  dagJson: WorkflowSchema,
  sloJson: JsonValueSchema.nullable(),
  upstreamHealthSources: z.array(z.string()).nullable(),
  createdBy: z.string().nullable(),
  createdAt: NullableIsoDateSchema,
});

const RunSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  workflowVersionId: z.string(),
  status: z.enum(runStatusValues),
  inputJson: JsonValueSchema.nullable(),
  outputJson: JsonValueSchema.nullable(),
  parentRunId: z.string().nullable(),
  parentNodeId: z.string().nullable(),
  traceId: z.string().nullable(),
  replayMode: z.string().nullable(),
  recoveryPlaybookValidationRecordedAt: NullableIsoDateSchema,
  recoveryPlaybookAppliedRecordedAt: NullableIsoDateSchema,
  createdBy: z.string().nullable(),
  createdAt: NullableIsoDateSchema,
});

const RunSummarySchema = RunSchema.omit({
  inputJson: true,
  recoveryPlaybookValidationRecordedAt: true,
  recoveryPlaybookAppliedRecordedAt: true,
}).extend({
  workflowId: z.string(),
  workflowName: z.string().nullable(),
});

const RunNodeSchema = z.object({
  id: z.string(),
  runId: z.string(),
  nodeId: z.string(),
  status: z.enum(nodeStatusValues),
  stateJson: JsonValueSchema.nullable(),
  attempts: z.number().int().nonnegative().nullable(),
  startedAt: NullableIsoDateSchema,
  finishedAt: NullableIsoDateSchema,
  errorJson: JsonValueSchema.nullable(),
});

const RunEventSchema = z.object({
  id: z.string(),
  runId: z.string(),
  nodeId: z.string().nullable(),
  type: z.string(),
  payload: JsonValueSchema.nullable(),
  createdAt: NullableIsoDateSchema,
  holdUntil: NullableIsoDateSchema,
});

const RunDetailSchema = z.object({
  run: RunSchema,
  nodes: z.array(RunNodeSchema),
  events: z.array(RunEventSchema),
  eventsCursor: z.string().nullable(),
  eventsHasMore: z.boolean(),
});

const RecoveryMetricSchema = z.object({
  value: z.number().nullable(),
  display: z.string(),
  severity: z.enum(["healthy", "warn", "unhealthy", "neutral"]),
  rationale: z.string(),
  rationaleCode: z.string(),
  rationaleMeta: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

const CostProviderRowSchema = z.object({
  provider: z.string(),
  model: z.string(),
  usd: z.number(),
  tokens: z.number(),
  calls: z.number(),
});

const RecoveryMetricsSchema = z.object({
  successRate: RecoveryMetricSchema,
  mttr: RecoveryMetricSchema,
  p95Latency: RecoveryMetricSchema,
  approvalsPending: RecoveryMetricSchema,
  replayRate: RecoveryMetricSchema,
  costThisWindow: RecoveryMetricSchema.extend({ providers: z.array(CostProviderRowSchema) }),
  clustersResolved: RecoveryMetricSchema.extend({
    totalEntries: z.number().int().nonnegative(),
    capped: z.boolean(),
  }),
  slaAttainment: RecoveryMetricSchema.extend({
    resolvedInWindow: z.number().int().nonnegative(),
    metSla: z.number().int().nonnegative(),
  }),
  timeToFirstAction: RecoveryMetricSchema,
  recurrenceRate: RecoveryMetricSchema,
  valueEstimate: z.object({
    hoursSaved: z.number(),
    dollarSaved: z.number(),
    mttrDeltaSeconds: z.number().nullable(),
    assumptions: z.object({
      hourlyCost: z.number(),
      minutesSavedPerRecovery: z.number(),
      baselineMttrSeconds: z.number(),
    }),
  }),
  windowDays: z.number().int().min(1).max(90),
  terminalRuns: z.number().int().nonnegative(),
  mttrTrend: z.array(z.object({ day: z.string(), seconds: z.number() })),
  downtimeEndedMs: z.number().nonnegative(),
});

export const recoveryMetricsContract = {
  operationId: "getRecoveryMetrics",
  path: V1_READ_PATHS.recoveryMetrics,
  summary: "Get the tenant recovery metrics rollup",
  tags: ["Recovery"],
  request: {
    query: z.object({
      windowDays: z.coerce.number().int().min(1).max(90).optional()
        .describe("Metrics window in days (1-90, default 30)."),
    }).strict(),
  },
  response: RecoveryMetricsSchema,
  errorCodes: ["invalid_input"],
} satisfies ApiRouteContract;

export const recoveryLedgerContract = {
  operationId: "getRecoveryLedger",
  path: V1_READ_PATHS.recoveryLedger,
  summary: "Get the tenant lifetime recovery impact ledger",
  tags: ["Recovery"],
  response: z.object({
    totalRecovered: z.number().int().nonnegative(),
    downtimeEndedMs: z.number().nonnegative(),
    sinceIso: NullableIsoDateSchema,
  }),
  errorCodes: [],
} satisfies ApiRouteContract;

export const recoveryMyWinsContract = {
  operationId: "getRecoveryMyWins",
  path: V1_READ_PATHS.recoveryMyWins,
  summary: "Get the authenticated operator's recent DLQ recoveries",
  tags: ["Recovery"],
  request: {
    query: z.object({
      days: z.coerce.number().int().optional()
        .describe("Rolling window in days; values are clamped to 1-90 (default 30)."),
    }).strict(),
  },
  response: z.object({
    recovered: z.number().int().nonnegative(),
    windowDays: z.number().int().min(1).max(90),
  }),
  errorCodes: ["invalid_input"],
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
      cron: z.string().max(100),
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

const RunDetailQuerySchema = z.object({
  runId: z.string().trim().min(1),
  eventsLimit: z.coerce.number().int().min(1).max(500).optional(),
  eventsCursor: KeysetCursorSchema.optional(),
}).strict();

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

/**
 * Side-effect-free contract manifest. The generator imports this instead of
 * the handler registry so contract checks never create Redis/DB clients.
 * A registry contract test pins parity with the real route entries.
 */
export const V1_CONTRACT_ROUTES: readonly ApiContractRouteDescriptor[] = [
  { method: "GET", role: "viewer", contract: recoveryMetricsContract },
  { method: "GET", role: "viewer", contract: recoveryLedgerContract },
  { method: "GET", role: "viewer", contract: recoveryMyWinsContract },
  { method: "GET", contract: listWorkflowsContract },
  { method: "GET", role: "viewer", permission: "workflows.read", contract: getSchedulePreviewContract },
  { method: "GET", contract: listWorkflowVersionsContract },
  { method: "GET", contract: getLatestWorkflowVersionContract },
  { method: "GET", contract: listRunsContract },
  { method: "GET", contract: getRunContract },
  { method: "GET", contract: getRunStatusContract },
];

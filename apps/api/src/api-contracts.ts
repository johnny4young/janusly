/**
 * Zod contracts for the first stable `/v1` API lane.
 *
 * Used by the recovery, workflow, run, and MCP connection route registries.
 * These schemas describe the JSON wire representation (dates are ISO strings,
 * never Date objects) and are reused for runtime output validation and OpenAPI
 * emission.
 */

import {
  EvidenceListSchema,
  RecoveryCaseStateSchema,
  UpstreamHealthSourceTagsSchema,
  ValidationEvidenceLevelSchema,
  WorkflowSchema,
  WorkflowSloBreachesSchema,
  WorkflowSloSchema,
} from "@janusly/shared";
import { V1_MCP_PATHS, V1_READ_PATHS, V1_WRITE_PATHS } from "@janusly/shared/src/api-contract";
import { nodeStatusValues, runStatusValues } from "@janusly/shared/src/status";
import { z } from "zod";

import type { ApiContractRouteDescriptor, ApiRouteContract } from "./api-contract-types";

const IsoDateSchema = z.iso.datetime({ offset: true });
const NullableIsoDateSchema = IsoDateSchema.nullable();
const JsonValueSchema = z.unknown();

const BudgetCheckResultSchema = z.object({
  allowed: z.boolean(),
  monthlyUsdSpent: z.number().nonnegative(),
  monthlyUsdLimit: z.number().nonnegative().nullable(),
  policy: z.enum(["warn", "block"]),
  warningPercent: z.number().min(0).max(100),
  warningThresholdCrossed: z.boolean(),
  exceededAt: z.enum(["org", "workflow"]).nullable(),
  resolvedScope: z.enum(["org", "workflow"]).nullable(),
}).strict();

const PositiveLimitSchema = z.coerce.number().int().min(1).max(200)
  .describe("Maximum number of rows to return (1-200).");

const KeysetCursorSchema = z.string().min(3).max(512)
  .describe("Opaque `<iso>|<id>` keyset cursor returned by the preceding page.");

const WorkflowTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  category: z.string().min(1),
  requiredCredentials: z.array(z.string()).optional(),
  workflow: WorkflowSchema,
  nameCode: z.string().min(1),
  descriptionCode: z.string().min(1),
  categoryCode: z.string().min(1),
});

const PublicToolSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  descriptionCode: z.string().min(1),
  required: z.array(z.string()).optional(),
  optional: z.array(z.string()).optional(),
  inputExample: z.record(z.string(), z.unknown()).optional(),
});

const WorkflowValidationIssueSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  nodeId: z.string().optional(),
  edgeId: z.string().optional(),
});

const WorkflowValidationResultSchema = z.object({
  valid: z.boolean(),
  issues: z.array(WorkflowValidationIssueSchema),
});

const ReadinessIssueSchema = WorkflowValidationIssueSchema.extend({
  severity: z.enum(["warn", "fail"]),
  suggestion: z.string().optional(),
});

const ReadinessResultSchema = z.object({
  status: z.enum(["pass", "warn", "fail"]),
  issues: z.array(ReadinessIssueSchema),
});

const HealthRationaleMetaSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);
const HealthBreakdownEntrySchema = z.object({
  score: z.number().int().min(0).max(100),
  rationale: z.string(),
  rationaleCode: z.enum([
    "reliability.no_runs",
    "reliability.summary",
    "safety.clean",
    "safety.summary",
    "latency.insufficient",
    "latency.summary",
    "cost.none",
    "cost.summary",
    "maintainability.summary",
    "ai_risk.no_ai",
    "ai_risk.summary",
  ]),
  rationaleMeta: HealthRationaleMetaSchema.optional(),
});
const WorkflowHealthSchema = z.object({
  score: z.number().int().min(0).max(100),
  status: z.enum(["healthy", "warn", "unhealthy"]),
  breakdown: z.object({
    reliability: HealthBreakdownEntrySchema,
    safety: HealthBreakdownEntrySchema,
    cost: HealthBreakdownEntrySchema,
    latency: HealthBreakdownEntrySchema,
    maintainability: HealthBreakdownEntrySchema,
    aiRisk: HealthBreakdownEntrySchema,
  }),
  signals: z.object({
    totalRuns: z.number().int().nonnegative(),
    successCount: z.number().int().nonnegative(),
    failureCount: z.number().int().nonnegative(),
    retryCount: z.number().int().nonnegative(),
    dlqOpenCount: z.number().int().nonnegative(),
    p95LatencyMs: z.number().nonnegative().nullable(),
    totalCostUsd: z.number().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    versionCount: z.number().int().nonnegative(),
  }),
  slo: z.object({
    slo: WorkflowSloSchema,
    breaches: WorkflowSloBreachesSchema,
  }).nullable().optional(),
});

const RunExplainReportSchema = z.object({
  generatedAt: IsoDateSchema,
  summary: z.object({
    runId: z.string().min(1).max(256),
    status: z.enum(runStatusValues),
    workflowVersionId: z.string().max(256).nullable(),
    parentRunId: z.string().max(256).nullable(),
    replayMode: z.string().max(64).nullable(),
    validationEvidenceLevel: ValidationEvidenceLevelSchema.nullable(),
    createdAt: NullableIsoDateSchema,
    isFailure: z.boolean(),
  }),
  rootCause: z.object({
    signature: z.string().max(240),
    category: z.enum([
      "secret_missing",
      "http_error",
      "network_timeout",
      "ai_provider",
      "parse_error",
      "tool_input",
      "unknown",
    ]),
    suggestedOwner: z.enum(["ops", "workflow_author", "platform"]),
  }).nullable(),
  failedNode: z.object({
    nodeId: z.string().max(120),
    status: z.enum(nodeStatusValues),
    attempts: z.number().int().nonnegative(),
    startedAt: NullableIsoDateSchema,
    finishedAt: NullableIsoDateSchema,
    errorSummary: z.string().max(240),
  }).nullable(),
  timeline: z.array(z.object({
    at: NullableIsoDateSchema,
    nodeId: z.string().max(120).nullable(),
    type: z.string().max(120),
  })).max(50),
  timelineTruncated: z.boolean(),
  suggestedFix: z.object({
    mode: z.enum(["ai", "fallback"]),
    topApproachLabel: z.string().max(120),
    envelopeKind: z.string().max(120),
    patchStyle: z.enum(["structural", "config_only", "unknown"]),
    suggestionsCount: z.number().int().nonnegative(),
    suggestedAt: NullableIsoDateSchema,
  }).nullable(),
  nextAction: z.string().min(1).max(500),
});

// Validation and readiness intentionally accept incomplete workflow objects:
// identifying structural failures is the purpose of these endpoints. Their
// successful result schemas remain strict enough to protect the stable wire.
const WorkflowCandidateBodySchema = z.record(z.string(), z.unknown());
const AiModelOverrideSchema = z.string().trim().min(1).max(256);
const GenerateWorkflowBodySchema = z.object({
  // Validation must not normalize the request: the v1 dispatcher validates a
  // cached body and the shared legacy handler deliberately consumes the raw
  // operator prompt for byte-compatible prompt/audit behavior.
  prompt: z.string().min(1).refine((value) => value.trim().length > 0, {
    message: "prompt must not be blank",
  }),
  model: AiModelOverrideSchema.optional(),
}).strict();
const GenerationBackoffSchema = z.object({
  from: z.number().int().min(2).max(5),
  to: z.literal(1),
}).strict();
const GenerateWorkflowResponseSchema = WorkflowSchema.safeExtend({
  mode: z.enum(["ai", "fallback"]),
  model: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  aiError: z.string().optional(),
  candidateCount: z.number().int().min(1).max(5).optional(),
  bonBackoff: GenerationBackoffSchema.optional(),
  budget: BudgetCheckResultSchema.optional(),
}).strict();

const RecoveryApproachLabelSchema = z.enum([
  "add_retry",
  "raise_timeout",
  "swap_secret_ref",
  "add_approval",
  "fix_url",
  "other",
]);
const RecoverySuggestionSafetySchema = z.object({
  writeSide: z.boolean(),
  approvalRequired: z.boolean(),
  approvalPresent: z.boolean(),
}).strict();
const ConsideredAlternativeSchema = z.object({
  approach: z.string().max(120),
  rejectedBecause: z.string().max(280),
}).strict();
const PatchSuggestionFields = {
  rationale: z.string(),
  approachLabel: RecoveryApproachLabelSchema,
  confidence: z.number().min(0).max(100),
  calibratedConfidence: z.number().min(0).max(100),
  safety: RecoverySuggestionSafetySchema,
  consideredAlternatives: z.array(ConsideredAlternativeSchema).max(2),
} as const;
const AiPatchSuggestionSchema = z.object({
  workflow: WorkflowSchema,
  ...PatchSuggestionFields,
}).strict();
const FallbackPatchSuggestionSchema = z.object({
  workflow: JsonValueSchema,
  ...PatchSuggestionFields,
}).strict();
const RecoveryFeedbackHealthSchema = z.object({
  windowDays: z.number().int().positive(),
  approaches: z.array(z.object({
    approachLabel: RecoveryApproachLabelSchema,
    feedbackLastSeen: IsoDateSchema,
    acceptedFixLastSeen: NullableIsoDateSchema,
    acceptedFixAgeDays: z.number().int().nonnegative().nullable(),
    state: z.enum(["active", "stale", "no_accepted_fix"]),
  }).strict()).max(20),
}).strict();
const RecoveryPassportSchema = z.object({
  failureSignature: z.string(),
  priorSameSignatureOutcome: z.object({
    status: z.enum(["validation_failed", "applied", "declined", "failed"]),
    approachLabel: z.string().nullable(),
    declineReason: z.enum([
      "loop_breaker_tripped",
      "budget_exceeded",
      "validation_failed",
      "signature_changed",
      "auto_apply_disabled",
      "manual_review",
      "signature_already_resolved",
      "validation_timeout",
      "scanner_error",
      "feature_disabled",
    ]).nullable(),
    occurredAt: IsoDateSchema,
  }).strict().nullable(),
}).strict();
const PatchWorkflowResponseFields = {
  rationale: z.string(),
  evidence: EvidenceListSchema,
  feedbackHealth: RecoveryFeedbackHealthSchema.optional(),
  recoveryPassport: RecoveryPassportSchema,
  model: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  budget: BudgetCheckResultSchema.optional(),
} as const;
const PatchWorkflowResponseSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("ai"),
    suggestedWorkflow: WorkflowSchema,
    suggestions: z.array(AiPatchSuggestionSchema).min(1).max(3),
    ...PatchWorkflowResponseFields,
  }).strict(),
  z.object({
    mode: z.literal("fallback"),
    suggestedWorkflow: JsonValueSchema,
    suggestions: z.array(FallbackPatchSuggestionSchema).min(1).max(3),
    aiError: z.string().optional(),
    ...PatchWorkflowResponseFields,
  }).strict(),
]);
const PatchWorkflowBodySchema = z.object({
  // Stable resource identifiers are canonical. Reject surrounding whitespace
  // rather than accepting a value that the byte-compatible legacy handler
  // would look up verbatim.
  deadLetterId: z.string().min(1).max(256).refine((value) => value === value.trim(), {
    message: "deadLetterId must not contain surrounding whitespace",
  }),
  model: AiModelOverrideSchema.optional(),
}).strict();
const SaveWorkflowBodySchema = WorkflowSchema.safeExtend({
  upstreamHealthSources: UpstreamHealthSourceTagsSchema.optional(),
}).strict();
const RollbackWorkflowBodySchema = z.object({
  workflowId: z.string().trim().min(1).max(256),
  sourceVersionId: z.string().trim().min(1).max(256),
}).strict();
const SavedWorkflowVersionSchema = z.object({
  workflowId: z.string().min(1),
  versionId: z.string().min(1),
  version: z.number().int().positive(),
});

const DlqStatusSchema = z.enum(["open", "replayed", "resolved"]);
const DlqSeveritySchema = z.enum(["p1", "p2", "p3", "p4"]);
const DlqSortSchema = z.enum(["newest", "oldest", "severity", "sla"]);
const DeadLetterRecoveryOverlaySchema = z.object({
  id: z.string().min(1),
  owner: z.string().nullable(),
  severity: DlqSeveritySchema,
  status: z.string().min(1),
  slaTargetAt: IsoDateSchema,
  resolutionReason: z.string().nullable(),
  comments: JsonValueSchema,
  workflowId: z.string().nullable(),
  metadataWorkflowId: z.string().nullable(),
  occurrenceCount: z.number().int().positive(),
  lastOccurredAt: IsoDateSchema,
}).strict();
const DeadLetterSummarySchema = z.object({
  id: z.string().min(1),
  orgId: z.string().min(1),
  runId: z.string().min(1),
  nodeId: z.string().min(1),
  attempt: z.number().int().positive(),
  errorJson: JsonValueSchema,
  status: DlqStatusSchema,
  replayedAt: NullableIsoDateSchema,
  createdAt: NullableIsoDateSchema,
  nodeType: z.string().nullable(),
  workflowName: z.string().nullable(),
  recovery: DeadLetterRecoveryOverlaySchema.nullable(),
}).strict();
const FailureClusterSchema = z.object({
  signature: z.string().min(1),
  category: z.enum([
    "secret_missing",
    "http_error",
    "network_timeout",
    "ai_provider",
    "parse_error",
    "tool_input",
    "unknown",
  ]),
  frequency: z.number().int().positive(),
  affectedWorkflows: z.array(z.object({
    workflowId: z.string().min(1),
    workflowName: z.string().min(1),
    count: z.number().int().positive(),
  }).strict()),
  firstSeen: IsoDateSchema,
  lastSeen: IsoDateSchema,
  suggestedOwner: z.enum(["ops", "workflow_author", "platform"]),
  samples: z.array(z.object({
    source: z.enum(["dead_letter", "failed_run_node"]),
    id: z.string().min(1),
    runId: z.string().min(1),
  }).strict()).max(5),
  recurredAfterRecovery: z.boolean(),
}).strict();
const ReplayDeadLetterBaseSchema = z.object({
  deadLetterId: z.string().trim().min(1).max(256),
  suggestedWorkflow: WorkflowSchema.optional(),
});
const ReplayDeadLetterBodySchema = ReplayDeadLetterBaseSchema.extend({
  recoveryPlaybookId: z.string().trim().min(1).max(256).optional()
    .describe("Recovery playbook id; requires recoveryValidationRunId."),
  recoveryValidationRunId: z.string().trim().min(1).max(256).optional()
    .describe("Successful validation run id; requires recoveryPlaybookId."),
}).strict().superRefine((value, ctx) => {
  if (Boolean(value.recoveryPlaybookId) === Boolean(value.recoveryValidationRunId)) return;
  ctx.addIssue({
    code: "custom",
    path: [value.recoveryPlaybookId ? "recoveryValidationRunId" : "recoveryPlaybookId"],
    message: "Recovery playbook id and validation run id must be provided together",
  });
});

const WorkflowListRowSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  name: z.string(),
  createdBy: z.string().nullable(),
  createdAt: NullableIsoDateSchema,
  lastRunStatus: z.string().nullable(),
  runCount: z.number().int().nonnegative(),
  bufferedTriggerCount: z.number().int().nonnegative(),
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
  outcomeStatus: z
    .enum([
      "semantic_violation",
      "semantic_quarantined",
      "semantic_recovered",
      "semantic_accepted_loss",
    ])
    .nullable()
    .optional(),
  semanticViolationCount: z.number().int().nonnegative().optional(),
  inputJson: JsonValueSchema.nullable(),
  outputJson: JsonValueSchema.nullable(),
  parentRunId: z.string().nullable(),
  parentNodeId: z.string().nullable(),
  traceId: z.string().nullable(),
  replayMode: z.string().nullable(),
  validationEvidenceLevel: ValidationEvidenceLevelSchema.nullable().optional(),
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

const RecoveryCaseSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  runId: z.string(),
  workflowId: z.string().nullable(),
  workflowVersionId: z.string(),
  source: z.literal("semantic_violation"),
  detectorId: z.string(),
  sourceNodeId: z.string(),
  detectorKind: z.enum(["expression", "schema"]),
  action: z.enum(["observe", "quarantine"]),
  message: z.string(),
  detailsJson: JsonValueSchema.nullable(),
  state: RecoveryCaseStateSchema,
  createdBy: z.string().nullable(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  resolvedAt: NullableIsoDateSchema,
});

const NonNegativeSafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const PositiveSafeIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

const RunUsageSchema = z.object({
  loadedRows: NonNegativeSafeIntegerSchema,
  truncated: z.boolean(),
  rowCap: PositiveSafeIntegerSchema,
  llm: z.object({
    calls: NonNegativeSafeIntegerSchema,
    inputTokens: NonNegativeSafeIntegerSchema,
    outputTokens: NonNegativeSafeIntegerSchema,
    totalTokens: NonNegativeSafeIntegerSchema,
    cachedInputTokens: NonNegativeSafeIntegerSchema,
    cacheCreationInputTokens: NonNegativeSafeIntegerSchema,
    knownCostUsd: z.number().nonnegative(),
    unknownCostCalls: NonNegativeSafeIntegerSchema,
  }),
  memory: z.object({
    recalls: NonNegativeSafeIntegerSchema,
    commits: NonNegativeSafeIntegerSchema,
    failures: NonNegativeSafeIntegerSchema,
    kinds: z.array(z.object({
      kind: z.string().min(1),
      recalls: NonNegativeSafeIntegerSchema,
      commits: NonNegativeSafeIntegerSchema,
      failures: NonNegativeSafeIntegerSchema,
    })),
  }),
}).refine((usage) => usage.loadedRows <= usage.rowCap, {
  message: "loadedRows must not exceed rowCap",
  path: ["loadedRows"],
});

const McpAliasSchema = z.string().trim().regex(/^[a-z0-9_-]{1,32}$/);
const McpToolNameSchema = z.string().trim().min(1).max(512);
const McpConnectionPathSchema = z.object({ alias: McpAliasSchema }).strict();
const McpConnectionToolPathSchema = z.object({
  alias: McpAliasSchema,
  toolName: McpToolNameSchema,
}).strict();
const McpEnvRefKeySchema = z.string().regex(/^(?:[a-z0-9_-]{1,32}|[A-Z][A-Z0-9_]{0,63})$/);
const McpEnvRefsSchema = z.record(
  McpEnvRefKeySchema,
  z.object({ kind: z.literal("env"), name: z.string().trim().min(1).max(128) }).strict(),
);
const McpConnectionSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  alias: McpAliasSchema,
  transport: z.enum(["stdio", "sse", "http"]),
  command: z.string().nullable(),
  args: z.array(z.string()).nullable(),
  url: z.string().nullable(),
  envRefs: McpEnvRefsSchema,
  enabled: z.boolean(),
  status: z.enum(["pending", "active", "failed", "disabled"]),
  statusReason: z.string().nullable(),
  exposeToAi: z.boolean(),
  lastDiscoveryAt: NullableIsoDateSchema,
  createdBy: z.string().nullable(),
  createdAt: NullableIsoDateSchema,
  updatedAt: NullableIsoDateSchema,
});
const McpToolDescriptorSchema = z.object({
  id: z.string(),
  connectionId: z.string(),
  name: McpToolNameSchema,
  description: z.string().nullable(),
  inputSchema: z.record(z.string(), z.unknown()).nullable(),
  writeSide: z.boolean(),
  enabled: z.boolean(),
  rateLimitPerMin: z.number().int().min(1).max(10_000).nullable(),
  exposeToAi: z.boolean(),
  createdAt: NullableIsoDateSchema,
  updatedAt: NullableIsoDateSchema,
});
const McpDiscoverySchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), tools: z.number().int().min(0).max(200) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
const McpCreateConnectionBodySchema = z.object({
  alias: McpAliasSchema,
  transport: z.enum(["stdio", "sse", "http"]),
  command: z.string().trim().min(1).max(512).optional(),
  args: z.array(z.string().min(1).max(200)).max(32).optional(),
  url: z.string().trim().min(1).max(2048).optional(),
  envRefs: McpEnvRefsSchema.optional(),
}).strict();
const McpUpdateConnectionBodySchema = z.object({
  enabled: z.boolean().optional(),
  envRefs: McpEnvRefsSchema.optional(),
  args: z.array(z.string().min(1).max(200)).max(32).optional(),
  url: z.string().trim().min(1).max(2048).optional(),
  command: z.string().trim().min(1).max(512).optional(),
  exposeToAi: z.boolean().optional(),
}).strict().refine((body) => Object.keys(body).length > 0, {
  message: "At least one updatable field is required",
});
const McpSetToolBodySchema = z.object({
  enabled: z.boolean().optional(),
  writeSide: z.boolean().optional(),
  rateLimitPerMin: z.number().int().min(1).max(10_000).nullable().optional(),
  exposeToAi: z.boolean().optional(),
}).strict().refine((body) => Object.keys(body).length > 0, {
  message: "At least one updatable field is required",
});

const MCP_CONNECTION_ERROR_CODES = [
  "mcp_alias_invalid",
  "mcp_alias_required",
  "mcp_connection_not_found",
] as const;
const MCP_WRITE_ERROR_CODES = ["mcp_process_disabled", "mcp_tenant_disabled"] as const;

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
  inputTokens: z.number().nonnegative(),
  cachedInputTokens: z.number().nonnegative(),
  cacheCreationInputTokens: z.number().nonnegative(),
  calls: z.number(),
  aggregated: z.boolean().optional(),
});

const RecoveryMetricsSchema = z.object({
  successRate: RecoveryMetricSchema,
  verifiedRecovery: RecoveryMetricSchema.extend({
    definitionVersion: z.literal("1"),
    metric: z.literal("time_to_verified_recovery"),
    unit: z.literal("milliseconds"),
    sampleSize: z.number().int().nonnegative(),
    p50Ms: z.number().int().nonnegative().nullable(),
    p90Ms: z.number().int().nonnegative().nullable(),
  }),
  mttr: RecoveryMetricSchema,
  p95Latency: RecoveryMetricSchema,
  approvalsPending: RecoveryMetricSchema,
  replayRate: RecoveryMetricSchema,
  costThisWindow: RecoveryMetricSchema.extend({
    providers: z.array(CostProviderRowSchema),
    cache: z.object({
      inputTokens: z.number().nonnegative(),
      readTokens: z.number().nonnegative(),
      creationTokens: z.number().nonnegative(),
      readSharePercent: z.number().min(0).max(100).nullable(),
    }),
  }),
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

export const memoryConsentStatusContract = {
  operationId: "getMemoryConsentStatus",
  path: V1_READ_PATHS.memoryConsentStatus,
  summary: "Get effective memory consent and pending purge status",
  tags: ["Memory"],
  response: z.object({
    enabled: z.boolean(),
    processEnabled: z.boolean(),
    tenantEnabled: z.boolean(),
    purge: z.discriminatedUnion("status", [
      z.object({ status: z.literal("none"), scheduledFor: z.null() }),
      z.object({ status: z.literal("scheduled"), scheduledFor: IsoDateSchema }),
      z.object({ status: z.literal("running"), scheduledFor: IsoDateSchema.nullable() }),
      z.object({ status: z.literal("unknown"), scheduledFor: z.null() }),
    ]),
  }),
  errorCodes: [],
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

export const listRecoveryCasesContract = {
  operationId: "listRecoveryCases",
  path: V1_READ_PATHS.recoveryCases,
  summary:
    "List durable semantic recovery cases for the tenant",
  tags: ["Recovery"],
  request: {
    query: z
      .object({
        openOnly: z.enum(["true", "false"]).optional(),
        runId: z.string().trim().min(1).max(256).optional(),
        limit: PositiveLimitSchema.optional(),
      })
      .strict(),
  },
  response: z.object({ cases: z.array(RecoveryCaseSchema) }),
  errorCodes: ["invalid_input"],
} satisfies ApiRouteContract;

export const recoverSemanticCaseContract = {
  operationId: "recoverSemanticCase",
  path: V1_WRITE_PATHS.recoverSemanticCase,
  summary:
    "Resolve a semantic quarantine or acknowledge an observe-only outcome",
  tags: ["Recovery"],
  request: {
    path: z
      .object({
        caseId: z.string().trim().min(1).max(256),
      })
      .strict(),
    body: z.discriminatedUnion("decision", [
      z
        .object({
          decision: z.literal("replace"),
          output: JsonValueSchema,
          reason: z.string().trim().min(1).max(1_000),
        })
        .strict(),
      z
        .object({
          decision: z.literal("accept_loss"),
          reason: z.string().trim().min(1).max(1_000),
        })
        .strict(),
    ]),
  },
  response: z.object({
    ok: z.literal(true),
    runId: z.string(),
    sourceNodeId: z.string(),
    decision: z.enum(["replace", "accept_loss"]),
    resumed: z.boolean(),
    resolvedCaseIds: z.array(z.string()),
  }),
  errorCodes: [
    "invalid_input",
    "recovery_case_not_found",
    "recovery_case_conflict",
    "recovery_semantic_output_invalid",
  ],
} satisfies ApiRouteContract;

export const listTemplatesContract = {
  operationId: "listTemplates",
  path: V1_READ_PATHS.templates,
  summary: "List built-in workflow recipes",
  tags: ["Catalogs"],
  response: z.array(WorkflowTemplateSchema),
  errorCodes: [],
} satisfies ApiRouteContract;

export const listToolsContract = {
  operationId: "listTools",
  path: V1_READ_PATHS.tools,
  summary: "List workflow runtime tools and their input fields",
  tags: ["Catalogs"],
  response: z.array(PublicToolSchema),
  errorCodes: [],
} satisfies ApiRouteContract;

export const generateWorkflowContract = {
  operationId: "generateWorkflow",
  path: V1_WRITE_PATHS.generateWorkflow,
  summary: "Generate a validated workflow draft from an operator prompt",
  tags: ["AI"],
  request: { body: GenerateWorkflowBodySchema },
  response: GenerateWorkflowResponseSchema,
  errorCodes: ["invalid_input", "ai_prompt_too_long", "budget_exceeded"],
} satisfies ApiRouteContract;

export const patchWorkflowContract = {
  operationId: "patchWorkflow",
  path: V1_WRITE_PATHS.patchWorkflow,
  summary: "Suggest bounded recovery patches for one dead letter",
  tags: ["AI", "Recovery"],
  request: { body: PatchWorkflowBodySchema },
  response: PatchWorkflowResponseSchema,
  errorCodes: [
    "invalid_input",
    "ai_dead_letter_id_required",
    "ai_run_not_found",
    "dlq_not_found",
    "budget_exceeded",
  ],
} satisfies ApiRouteContract;

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

export const getRunExplainReportContract = {
  operationId: "getRunExplainReport",
  path: V1_READ_PATHS.runExplainReport,
  summary: "Get a structured deterministic explanation of one run",
  tags: ["Reports"],
  request: {
    query: z.object({
      runId: z.string().min(1).max(256),
      format: z.literal("json")
        .describe("The stable API exposes structured JSON only; downloadable artifacts remain on the legacy route."),
    }).strict(),
  },
  response: RunExplainReportSchema,
  errorCodes: ["invalid_input", "reports_run_not_found"],
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

export const listDeadLettersContract = {
  operationId: "listDeadLetters",
  path: V1_READ_PATHS.deadLetters,
  summary: "List bounded dead-letter summaries with recovery ownership state",
  tags: ["Recovery"],
  request: {
    query: z.object({
      status: DlqStatusSchema.optional(),
      severity: DlqSeveritySchema.optional(),
      sort: DlqSortSchema.optional(),
      owner: z.string().trim().min(1).max(200).optional(),
      search: z.string().trim().min(1).max(100).optional(),
      limit: PositiveLimitSchema.optional(),
    }).strict(),
  },
  response: z.array(DeadLetterSummarySchema),
  errorCodes: ["invalid_input"],
} satisfies ApiRouteContract;

export const listFailureClustersContract = {
  operationId: "listFailureClusters",
  path: V1_READ_PATHS.failureClusters,
  summary: "Group recent production failures by scrubbed normalized signature",
  tags: ["Recovery"],
  request: {
    query: z.object({
      windowDays: z.coerce.number().int().min(1).max(90).optional()
        .describe("Failure lookback window in days (1-90, default 30)."),
    }).strict(),
  },
  response: z.object({
    clusters: z.array(FailureClusterSchema),
    totalSamples: z.number().int().nonnegative(),
    windowDays: z.number().int().min(1).max(90),
  }).strict(),
  errorCodes: ["invalid_input"],
} satisfies ApiRouteContract;

export const replayDeadLetterContract = {
  operationId: "replayDeadLetter",
  path: V1_WRITE_PATHS.replayDeadLetter,
  summary: "Replay one dead letter through the generation-bound recovery claim path",
  tags: ["Recovery"],
  request: { body: ReplayDeadLetterBodySchema },
  response: z.object({ ok: z.literal(true) }).strict(),
  errorCodes: [
    "invalid_input",
    "dlq_not_found",
    "dlq_failing_node_missing",
    "dlq_node_mid_retry",
    "dlq_replay_conflict",
    "dlq_workflow_sanitize_failed",
    "recovery_playbook_outcome_invalid",
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

export const listMcpConnectionsContract = {
  operationId: "listMcpConnections",
  path: V1_MCP_PATHS.connections,
  summary: "List outbound MCP connections for the tenant",
  tags: ["MCP Connections"],
  response: z.object({
    connections: z.array(McpConnectionSchema.extend({
      toolCount: z.number().int().nonnegative(),
      enabledToolCount: z.number().int().nonnegative(),
    })),
  }),
  errorCodes: [],
} satisfies ApiRouteContract;

export const createMcpConnectionContract = {
  operationId: "createMcpConnection",
  path: V1_MCP_PATHS.connections,
  summary: "Register and discover an outbound MCP connection",
  tags: ["MCP Connections"],
  request: { body: McpCreateConnectionBodySchema },
  response: z.object({
    connection: McpConnectionSchema.nullable(),
    tools: z.array(McpToolDescriptorSchema),
    discovery: McpDiscoverySchema,
  }),
  errorCodes: [
    "invalid_input",
    "mcp_alias_invalid",
    "mcp_transport_invalid",
    "mcp_command_required",
    "mcp_command_allowlist_empty",
    "mcp_command_not_allowed",
    "mcp_url_required",
    "mcp_connection_duplicate",
    ...MCP_WRITE_ERROR_CODES,
  ],
} satisfies ApiRouteContract;

export const updateMcpConnectionContract = {
  operationId: "updateMcpConnection",
  path: V1_MCP_PATHS.connection,
  summary: "Update an outbound MCP connection",
  tags: ["MCP Connections"],
  request: {
    path: McpConnectionPathSchema,
    body: McpUpdateConnectionBodySchema,
  },
  response: McpConnectionSchema.nullable(),
  errorCodes: [
    "invalid_input",
    ...MCP_CONNECTION_ERROR_CODES,
    "mcp_url_invalid",
    "mcp_command_invalid",
    "mcp_command_not_allowed",
    "mcp_no_updatable_fields",
    ...MCP_WRITE_ERROR_CODES,
  ],
} satisfies ApiRouteContract;

export const deleteMcpConnectionContract = {
  operationId: "deleteMcpConnection",
  path: V1_MCP_PATHS.connection,
  summary: "Delete an outbound MCP connection",
  tags: ["MCP Connections"],
  request: { path: McpConnectionPathSchema },
  response: z.object({ ok: z.literal(true) }),
  errorCodes: ["invalid_input", ...MCP_CONNECTION_ERROR_CODES, ...MCP_WRITE_ERROR_CODES],
} satisfies ApiRouteContract;

export const rediscoverMcpConnectionContract = {
  operationId: "rediscoverMcpConnection",
  path: V1_MCP_PATHS.rediscoverConnection,
  summary: "Rediscover tools for an outbound MCP connection",
  tags: ["MCP Connections"],
  request: {
    path: McpConnectionPathSchema,
    body: z.object({}).strict(),
  },
  response: z.object({
    connection: McpConnectionSchema.nullable(),
    tools: z.array(McpToolDescriptorSchema),
    discovery: McpDiscoverySchema,
  }),
  errorCodes: [
    "invalid_input",
    ...MCP_CONNECTION_ERROR_CODES,
    "mcp_rate_limited",
    ...MCP_WRITE_ERROR_CODES,
  ],
} satisfies ApiRouteContract;

export const listMcpConnectionToolsContract = {
  operationId: "listMcpConnectionTools",
  path: V1_MCP_PATHS.connectionTools,
  summary: "List cached tools for an outbound MCP connection",
  tags: ["MCP Connections"],
  request: { path: McpConnectionPathSchema },
  response: z.object({ tools: z.array(McpToolDescriptorSchema) }),
  errorCodes: ["invalid_input", ...MCP_CONNECTION_ERROR_CODES],
} satisfies ApiRouteContract;

export const setMcpConnectionToolContract = {
  operationId: "setMcpConnectionTool",
  path: V1_MCP_PATHS.connectionTool,
  summary: "Update operator-controlled MCP tool flags",
  tags: ["MCP Connections"],
  request: {
    path: McpConnectionToolPathSchema,
    body: McpSetToolBodySchema,
  },
  response: McpToolDescriptorSchema.nullable(),
  errorCodes: [
    "invalid_input",
    ...MCP_CONNECTION_ERROR_CODES,
    "mcp_alias_tool_required",
    "mcp_tool_not_found",
    "mcp_rate_limit_invalid",
    "mcp_no_updatable_fields",
    ...MCP_WRITE_ERROR_CODES,
  ],
} satisfies ApiRouteContract;

/**
 * Side-effect-free contract manifest. The generator imports this instead of
 * the handler registry so contract checks never create Redis/DB clients.
 * A registry contract test pins parity with the real route entries.
 */
export const V1_CONTRACT_ROUTES: readonly ApiContractRouteDescriptor[] = [
  { method: "GET", role: "viewer", permission: "recovery.read", contract: memoryConsentStatusContract },
  { method: "GET", role: "viewer", permission: "recovery.read", contract: recoveryMetricsContract },
  { method: "GET", role: "viewer", permission: "recovery.read", contract: recoveryLedgerContract },
  { method: "GET", role: "viewer", permission: "recovery.read", contract: recoveryMyWinsContract },
  { method: "GET", role: "viewer", permission: "recovery.read", contract: listRecoveryCasesContract },
  { method: "POST", role: "editor", permission: "recovery.write", contract: recoverSemanticCaseContract },
  { method: "GET", contract: listTemplatesContract },
  { method: "GET", contract: listToolsContract },
  { method: "POST", permission: "ai.write", contract: generateWorkflowContract },
  { method: "POST", role: "editor", permission: "ai.write", contract: patchWorkflowContract },
  { method: "POST", role: "editor", permission: "workflows.write", contract: validateWorkflowContract },
  { method: "POST", role: "editor", permission: "workflows.write", contract: checkWorkflowReadinessContract },
  { method: "GET", role: "viewer", permission: "workflows.read", contract: getWorkflowHealthContract },
  { method: "GET", role: "viewer", permission: "reports.read", contract: getRunExplainReportContract },
  { method: "POST", role: "editor", permission: "workflows.write", contract: saveWorkflowContract },
  { method: "POST", role: "editor", permission: "workflows.write", contract: rollbackWorkflowContract },
  { method: "GET", role: "viewer", permission: "dlq.read", contract: listDeadLettersContract },
  { method: "GET", role: "viewer", permission: "dlq.read", contract: listFailureClustersContract },
  { method: "POST", role: "editor", permission: "dlq.replay", contract: replayDeadLetterContract },
  { method: "GET", contract: listWorkflowsContract },
  { method: "GET", role: "viewer", permission: "workflows.read", contract: getSchedulePreviewContract },
  { method: "GET", contract: listWorkflowVersionsContract },
  { method: "GET", contract: getLatestWorkflowVersionContract },
  { method: "GET", contract: listRunsContract },
  { method: "GET", contract: getRunContract },
  { method: "GET", permission: "runs.read", contract: getRunUsageContract },
  { method: "GET", contract: getRunStatusContract },
  { method: "POST", role: "editor", permission: "runs.start", contract: redriveRunContract },
  { method: "POST", role: "editor", permission: "runs.start", contract: startRunContract },
  { method: "POST", role: "editor", permission: "runs.start", contract: resumeRunContract },
  { method: "POST", role: "editor", permission: "runs.cancel", contract: cancelRunContract },
  { method: "POST", permission: "workflows.write", contract: resumeWorkflowContract },
  { method: "GET", role: "viewer", permission: "mcp.connections.read", contract: listMcpConnectionsContract },
  { method: "POST", role: "admin", permission: "mcp.connections.write", contract: createMcpConnectionContract },
  { method: "POST", role: "admin", permission: "mcp.connections.write", contract: updateMcpConnectionContract },
  { method: "DELETE", role: "admin", permission: "mcp.connections.write", contract: deleteMcpConnectionContract },
  { method: "POST", role: "admin", permission: "mcp.connections.write", contract: rediscoverMcpConnectionContract },
  { method: "GET", role: "viewer", permission: "mcp.connections.read", contract: listMcpConnectionToolsContract },
  { method: "POST", role: "admin", permission: "mcp.connections.write", contract: setMcpConnectionToolContract },
];

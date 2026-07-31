/**
 * Side-effect-free Zod wire schemas shared by the domain contract modules.
 * Dates remain ISO strings because response validation happens after JSON
 * serialization. Keep route metadata and handler imports out of this module.
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
import { nodeStatusValues, runStatusValues } from "@janusly/shared/src/status";
import { z } from "zod";


export const IsoDateSchema = z.iso.datetime({ offset: true });
export const NullableIsoDateSchema = IsoDateSchema.nullable();
export const JsonValueSchema = z.unknown();

export const BudgetCheckResultSchema = z.object({
  allowed: z.boolean(),
  monthlyUsdSpent: z.number().nonnegative(),
  monthlyUsdLimit: z.number().nonnegative().nullable(),
  policy: z.enum(["warn", "block"]),
  warningPercent: z.number().min(0).max(100),
  warningThresholdCrossed: z.boolean(),
  exceededAt: z.enum(["org", "workflow"]).nullable(),
  resolvedScope: z.enum(["org", "workflow"]).nullable(),
}).strict();

export const PositiveLimitSchema = z.coerce.number().int().min(1).max(200)
  .describe("Maximum number of rows to return (1-200).");

export const KeysetCursorSchema = z.string().min(3).max(512)
  .describe("Opaque `<iso>|<id>` keyset cursor returned by the preceding page.");

export const WorkflowTemplateSchema = z.object({
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

export const PublicToolSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  descriptionCode: z.string().min(1),
  required: z.array(z.string()).optional(),
  optional: z.array(z.string()).optional(),
  inputExample: z.record(z.string(), z.unknown()).optional(),
  inputFields: z.array(z.object({
    name: z.string().min(1),
    kind: z.enum(["string", "number", "integer", "boolean", "json"]),
    required: z.boolean(),
    options: z.array(z.string()).optional(),
  })),
  writeSide: z.boolean(),
});

export const WorkflowValidationIssueSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  nodeId: z.string().optional(),
  edgeId: z.string().optional(),
});

export const WorkflowValidationResultSchema = z.object({
  valid: z.boolean(),
  issues: z.array(WorkflowValidationIssueSchema),
});

export const ReadinessIssueSchema = WorkflowValidationIssueSchema.extend({
  severity: z.enum(["warn", "fail"]),
  suggestion: z.string().optional(),
});

export const ReadinessResultSchema = z.object({
  status: z.enum(["pass", "warn", "fail"]),
  issues: z.array(ReadinessIssueSchema),
});

export const HealthRationaleMetaSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);
export const HealthBreakdownEntrySchema = z.object({
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
export const WorkflowHealthSchema = z.object({
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

export const RunExplainReportSchema = z.object({
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
export const WorkflowCandidateBodySchema = z.record(z.string(), z.unknown());
export const AiModelOverrideSchema = z.string().trim().min(1).max(256);
export const GenerateWorkflowBodySchema = z.object({
  // Validation must not normalize the request: the v1 dispatcher validates a
  // cached body and the shared legacy handler deliberately consumes the raw
  // operator prompt for byte-compatible prompt/audit behavior.
  prompt: z.string().min(1).refine((value) => value.trim().length > 0, {
    message: "prompt must not be blank",
  }),
  model: AiModelOverrideSchema.optional(),
}).strict();
export const GenerationBackoffSchema = z.object({
  from: z.number().int().min(2).max(5),
  to: z.literal(1),
}).strict();
export const GenerateWorkflowResponseSchema = WorkflowSchema.safeExtend({
  mode: z.enum(["ai", "fallback"]),
  model: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  aiError: z.string().optional(),
  candidateCount: z.number().int().min(1).max(5).optional(),
  bonBackoff: GenerationBackoffSchema.optional(),
  budget: BudgetCheckResultSchema.optional(),
}).strict();

export const RecoveryApproachLabelSchema = z.enum([
  "add_retry",
  "raise_timeout",
  "swap_secret_ref",
  "add_approval",
  "fix_url",
  "other",
]);
export const RecoverySuggestionSafetySchema = z.object({
  writeSide: z.boolean(),
  approvalRequired: z.boolean(),
  approvalPresent: z.boolean(),
}).strict();
export const ConsideredAlternativeSchema = z.object({
  approach: z.string().max(120),
  rejectedBecause: z.string().max(280),
}).strict();
export const PatchSuggestionFields = {
  rationale: z.string(),
  approachLabel: RecoveryApproachLabelSchema,
  confidence: z.number().min(0).max(100),
  calibratedConfidence: z.number().min(0).max(100),
  safety: RecoverySuggestionSafetySchema,
  consideredAlternatives: z.array(ConsideredAlternativeSchema).max(2),
} as const;
export const AiPatchSuggestionSchema = z.object({
  workflow: WorkflowSchema,
  ...PatchSuggestionFields,
}).strict();
export const FallbackPatchSuggestionSchema = z.object({
  workflow: JsonValueSchema,
  ...PatchSuggestionFields,
}).strict();
export const RecoveryFeedbackHealthSchema = z.object({
  windowDays: z.number().int().positive(),
  approaches: z.array(z.object({
    approachLabel: RecoveryApproachLabelSchema,
    feedbackLastSeen: IsoDateSchema,
    acceptedFixLastSeen: NullableIsoDateSchema,
    acceptedFixAgeDays: z.number().int().nonnegative().nullable(),
    state: z.enum(["active", "stale", "no_accepted_fix"]),
  }).strict()).max(20),
}).strict();
export const RecoveryPassportSchema = z.object({
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
export const PatchWorkflowResponseFields = {
  rationale: z.string(),
  evidence: EvidenceListSchema,
  feedbackHealth: RecoveryFeedbackHealthSchema.optional(),
  recoveryPassport: RecoveryPassportSchema,
  model: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  budget: BudgetCheckResultSchema.optional(),
} as const;
export const PatchWorkflowResponseSchema = z.discriminatedUnion("mode", [
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
export const PatchWorkflowBodySchema = z.object({
  // Stable resource identifiers are canonical. Reject surrounding whitespace
  // rather than accepting a value that the byte-compatible legacy handler
  // would look up verbatim.
  deadLetterId: z.string().min(1).max(256).refine((value) => value === value.trim(), {
    message: "deadLetterId must not contain surrounding whitespace",
  }),
  model: AiModelOverrideSchema.optional(),
}).strict();
export const SaveWorkflowBodySchema = WorkflowSchema.safeExtend({
  upstreamHealthSources: UpstreamHealthSourceTagsSchema.optional(),
}).strict();
export const RollbackWorkflowBodySchema = z.object({
  workflowId: z.string().trim().min(1).max(256),
  sourceVersionId: z.string().trim().min(1).max(256),
}).strict();
export const SavedWorkflowVersionSchema = z.object({
  workflowId: z.string().min(1),
  versionId: z.string().min(1),
  version: z.number().int().positive(),
});

export const DlqStatusSchema = z.enum(["open", "replayed", "resolved"]);
export const DlqSeveritySchema = z.enum(["p1", "p2", "p3", "p4"]);
export const DlqSortSchema = z.enum(["newest", "oldest", "severity", "sla"]);
export const DeadLetterRecoveryOverlaySchema = z.object({
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
export const DeadLetterSummarySchema = z.object({
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
export const FailureClusterSchema = z.object({
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
export const ReplayDeadLetterBaseSchema = z.object({
  deadLetterId: z.string().trim().min(1).max(256),
  suggestedWorkflow: WorkflowSchema.optional(),
});
export const ReplayDeadLetterBodySchema = ReplayDeadLetterBaseSchema.extend({
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

export const WorkflowListRowSchema = z.object({
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

export const WorkflowVersionSchema = z.object({
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

export const RunSchema = z.object({
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

export const RunSummarySchema = RunSchema.omit({
  inputJson: true,
  recoveryPlaybookValidationRecordedAt: true,
  recoveryPlaybookAppliedRecordedAt: true,
}).extend({
  workflowId: z.string(),
  workflowName: z.string().nullable(),
  hasWaitingNodes: z.boolean().optional(),
});

export const RunNodeSchema = z.object({
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

export const RunEventSchema = z.object({
  id: z.string(),
  runId: z.string(),
  nodeId: z.string().nullable(),
  type: z.string(),
  payload: JsonValueSchema.nullable(),
  createdAt: NullableIsoDateSchema,
  holdUntil: NullableIsoDateSchema,
});

export const RunDetailSchema = z.object({
  run: RunSchema,
  nodes: z.array(RunNodeSchema),
  events: z.array(RunEventSchema),
  eventsCursor: z.string().nullable(),
  eventsHasMore: z.boolean(),
});

export const RecoveryCaseSchema = z.object({
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

export const RecoveryCaseTransitionSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  caseId: z.string(),
  fromState: RecoveryCaseStateSchema,
  toState: RecoveryCaseStateSchema,
  actorKind: z.enum(["system", "user", "agent"]),
  actorId: z.string().nullable(),
  evidenceJson: JsonValueSchema,
  reason: z.string().nullable(),
  occurredAt: IsoDateSchema,
});

export const RecoveryAutonomyLevelSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);
export const RecoveryAutonomyProfileSchema = z.object({
  level: RecoveryAutonomyLevelSchema.nullable(),
  source: z.enum([
    "failure_override",
    "workflow_default",
    "strictest_failure",
    "unavailable",
  ]),
  detectorIds: z.array(z.string()),
  unavailableReason: z.enum([
    "contract_missing",
    "failure_policy_missing",
  ]).nullable(),
  capabilities: z.object({
    observe: z.boolean(),
    recommend: z.boolean(),
    validate: z.boolean(),
    applyWithApproval: z.boolean(),
    autonomousApply: z.boolean(),
  }),
  factors: z.array(z.object({
    capability: z.enum([
      "observe",
      "recommend",
      "validate",
      "apply_with_approval",
      "autonomous_apply",
    ]),
    requiredLevel: RecoveryAutonomyLevelSchema,
    enabled: z.boolean(),
  })),
});

export const NonNegativeSafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const PositiveSafeIntegerSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const RunUsageSchema = z.object({
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

export const McpAliasSchema = z.string().trim().regex(/^[a-z0-9_-]{1,32}$/);
export const McpToolNameSchema = z.string().trim().min(1).max(512);
export const McpConnectionPathSchema = z.object({ alias: McpAliasSchema }).strict();
export const McpConnectionToolPathSchema = z.object({
  alias: McpAliasSchema,
  toolName: McpToolNameSchema,
}).strict();
export const McpEnvRefKeySchema = z.string().regex(/^(?:[a-z0-9_-]{1,32}|[A-Z][A-Z0-9_]{0,63})$/);
export const McpEnvRefsSchema = z.record(
  McpEnvRefKeySchema,
  z.object({ kind: z.literal("env"), name: z.string().trim().min(1).max(128) }).strict(),
);
export const McpConnectionSchema = z.object({
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
export const McpToolDescriptorSchema = z.object({
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
export const McpDiscoverySchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), tools: z.number().int().min(0).max(200) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export const McpCreateConnectionBodySchema = z.object({
  alias: McpAliasSchema,
  transport: z.enum(["stdio", "sse", "http"]),
  command: z.string().trim().min(1).max(512).optional(),
  args: z.array(z.string().min(1).max(200)).max(32).optional(),
  url: z.string().trim().min(1).max(2048).optional(),
  envRefs: McpEnvRefsSchema.optional(),
}).strict();
export const McpUpdateConnectionBodySchema = z.object({
  enabled: z.boolean().optional(),
  envRefs: McpEnvRefsSchema.optional(),
  args: z.array(z.string().min(1).max(200)).max(32).optional(),
  url: z.string().trim().min(1).max(2048).optional(),
  command: z.string().trim().min(1).max(512).optional(),
  exposeToAi: z.boolean().optional(),
}).strict().refine((body) => Object.keys(body).length > 0, {
  message: "At least one updatable field is required",
});
export const McpSetToolBodySchema = z.object({
  enabled: z.boolean().optional(),
  writeSide: z.boolean().optional(),
  rateLimitPerMin: z.number().int().min(1).max(10_000).nullable().optional(),
  exposeToAi: z.boolean().optional(),
}).strict().refine((body) => Object.keys(body).length > 0, {
  message: "At least one updatable field is required",
});

export const MCP_CONNECTION_ERROR_CODES = [
  "mcp_alias_invalid",
  "mcp_alias_required",
  "mcp_connection_not_found",
] as const;
export const MCP_WRITE_ERROR_CODES = ["mcp_process_disabled", "mcp_tenant_disabled"] as const;

export const RecoveryMetricSchema = z.object({
  value: z.number().nullable(),
  display: z.string(),
  severity: z.enum(["healthy", "warn", "unhealthy", "neutral"]),
  rationale: z.string(),
  rationaleCode: z.string(),
  rationaleMeta: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

export const CostProviderRowSchema = z.object({
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

export const RecoveryMetricsSchema = z.object({
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

export const RunDetailQuerySchema = z.object({
  runId: z.string().trim().min(1),
  eventsLimit: z.coerce.number().int().min(1).max(500).optional(),
  eventsCursor: KeysetCursorSchema.optional(),
}).strict();

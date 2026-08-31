/**
 * Zero-dependency path catalogs for the stable `/v1` API lane.
 *
 * Used by `internal/contract` and `web/src/api.ts`. Keeping the
 * values here prevents the browser transport map from drifting from OpenAPI.
 */

export const V1_READ_PATHS = {
  authoringCapabilities: "/authoring/capabilities",
  operationsBrief: "/operations/brief",
  memoryConsentStatus: "/memory/consent-status",
  recoveryMetrics: "/recovery/metrics",
  recoveryLedger: "/recovery/ledger",
  recoveryMyWins: "/recovery/my-wins",
  recoveryCases: "/recovery/cases",
  recoveryCase: "/recovery/cases/{caseId}",
  templates: "/templates",
  tools: "/tools",
  workflows: "/workflows",
  workflowHealth: "/workflows/health",
  schedulePreview: "/workflows/schedule-preview",
  workflowVersions: "/workflows/versions",
  latestWorkflowVersion: "/workflows/latest",
  runs: "/runs",
  run: "/run",
  runUsage: "/run/usage",
  runStatus: "/status",
  runExplainReport: "/reports/run-explain",
  deadLetters: "/dlq",
  failureClusters: "/dlq/clusters",
} as const;

export type V1ReadPath = typeof V1_READ_PATHS[keyof typeof V1_READ_PATHS];

/** Stable mutation paths exposed to first-party and SDK callers. */
export const V1_WRITE_PATHS = {
  compileWorkflowBrief: "/ai/workflow-briefs/compile",
  proposeWorkflow: "/ai/workflow-proposals",
  generateWorkflow: "/ai/generate-workflow",
  patchWorkflow: "/ai/patch-workflow",
  validateWorkflow: "/validate",
  workflowReadiness: "/workflows/readiness",
  saveWorkflow: "/workflows/save",
  rollbackWorkflow: "/workflows/rollback",
  startRun: "/start",
  redriveRun: "/runs/redrive",
  resumeRun: "/resume",
  cancelRun: "/run/cancel",
  resumeWorkflow: "/workflows/{workflowId}/resume",
  replayDeadLetter: "/dlq/replay",
  diagnoseRecoveryCase: "/recovery/cases/{caseId}/diagnose",
  createRecoveryCandidates: "/recovery/cases/{caseId}/candidates",
  validateRecoveryCandidate: "/recovery/cases/{caseId}/validate",
  approveRecoveryCandidate: "/recovery/cases/{caseId}/approve",
  applyRecoveryCandidate: "/recovery/cases/{caseId}/apply",
} as const;

export type V1WritePath = typeof V1_WRITE_PATHS[keyof typeof V1_WRITE_PATHS];

/** Stable MCP connection-management paths, including OpenAPI templates. */
export const V1_MCP_PATHS = {
  connections: "/mcp/connections",
  connection: "/mcp/connections/{alias}",
  rediscoverConnection: "/mcp/connections/{alias}/rediscover",
  connectionTools: "/mcp/connections/{alias}/tools",
  connectionTool: "/mcp/connections/{alias}/tools/{toolName}",
} as const;

export type V1McpPath = typeof V1_MCP_PATHS[keyof typeof V1_MCP_PATHS];

const V1_READ_PATH_SET: ReadonlySet<string> = new Set(Object.values(V1_READ_PATHS));

/** True when an exact URL pathname belongs to the stable v1 read lane. */
export function isV1ReadPath(pathname: string): pathname is V1ReadPath {
  return V1_READ_PATH_SET.has(pathname);
}

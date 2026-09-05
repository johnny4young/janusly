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
  workflowVersion: "/workflows/versions/{versionId}",
  latestWorkflowVersion: "/workflows/latest",
  runs: "/runs",
  run: "/run",
  runUsage: "/run/usage",
  runStatus: "/status",
  runExplainReport: "/reports/run-explain",
  deadLetters: "/dlq",
  failureClusters: "/dlq/clusters",
} as const;

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

/** Stable MCP connection-management paths, including OpenAPI templates. */
export const V1_MCP_PATHS = {
  connections: "/mcp/connections",
  connection: "/mcp/connections/{alias}",
  rediscoverConnection: "/mcp/connections/{alias}/rediscover",
  connectionTools: "/mcp/connections/{alias}/tools",
  connectionTool: "/mcp/connections/{alias}/tools/{toolName}",
} as const;

const V1_READ_PATH_SET: ReadonlySet<string> = new Set(Object.values(V1_READ_PATHS));
const V1_READ_PATH_TEMPLATES = Object.values(V1_READ_PATHS)
  .filter(path => path.includes('{'))
  .map(path => path.split('/'));

/** True when an exact or concrete templated pathname belongs to the v1 lane. */
export function isV1ReadPath(pathname: string): boolean {
  if (V1_READ_PATH_SET.has(pathname)) return true;
  const segments = pathname.split('/');
  return V1_READ_PATH_TEMPLATES.some(template => (
    template.length === segments.length
    && template.every((segment, index) => (
      segment.startsWith('{') && segment.endsWith('}')
        ? (segments[index]?.length ?? 0) > 0
        : segment === segments[index]
    ))
  ));
}

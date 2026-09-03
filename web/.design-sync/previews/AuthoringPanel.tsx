import { AuthoringPanel } from '@janusly/web'
import { graphEdges, graphNodes, runNodes, savedWorkflows, tools } from './_fixtures'

/**
 * The canvas side panel: the inspector for the current selection, plus the
 * validation and readiness results for the workflow as a whole.
 *
 * The two permissions are independent. `canWrite` gates editing; `canUseAi`
 * gates the AI authoring actions, which a workspace can switch off without
 * making the workflow read-only — the panel then shows the same evidence with
 * the AI entry points absent rather than disabled.
 */

const model = {
  runNodes,
  selectedNode: graphNodes[0],
  selectedEdge: null,
  workflowNodes: graphNodes,
  workflowEdges: graphEdges,
  validationIssues: [
    {
      code: 'missing_retry_policy',
      message: 'Step "Fetch invoice" calls an external host with no retry policy.',
      nodeId: 'fetch_invoice',
    },
  ],
  readinessResult: {
    status: 'warn' as const,
    issues: [
      {
        code: 'missing_retry_policy',
        severity: 'warn' as const,
        message: 'Step "Fetch invoice" calls an external host with no retry policy.',
        suggestion: 'Add a retry with backoff so a single 5xx does not fail the run.',
        nodeId: 'fetch_invoice',
      },
    ],
  },
  aiReviewIssues: [],
  tools,
  workflows: savedWorkflows,
  currentWorkflowId: 'wf_invoice_recon',
  currentWorkflowName: 'Invoice reconciliation',
  onUpdateNodeConfig: () => {},
  onUpdateNodeType: () => {},
  onUpdateEdgeCondition: () => {},
  onUpdateEdgeOnError: () => {},
  onValidateWorkflow: async () => true,
  onInsertSnippet: () => {},
}

/** An editor with AI authoring available. */
export function FullAccess() {
  return <AuthoringPanel model={model} canWrite canUseAi onOpenAiAction={() => {}} />
}

/** Editing allowed, AI switched off for the workspace. */
export function WithoutAi() {
  return <AuthoringPanel model={model} canWrite canUseAi={false} onOpenAiAction={() => {}} />
}

/** A viewer: the panel reads as evidence, not as an editor. */
export function ReadOnly() {
  return <AuthoringPanel model={model} canWrite={false} canUseAi={false} onOpenAiAction={() => {}} />
}

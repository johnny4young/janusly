/** The one route from a problem, wherever it is shown, to the element that resolves it. */

import { useWorkflowStore } from '../store'
import { requestAuthoringFocus, requestAuthoringScope, type AuthoringWorkflowTarget } from './authoring-focus-bus'
import type { AuthoringProblem } from './authoring-problems'
import { requestResilienceFocus } from './resilience-focus-bus'

const resilienceIssueCodes = new Set(['external_node_missing_retry', 'http_missing_bounds', 'tool_result_policy_missing'])
const workflowTargets = new Map<string, AuthoringWorkflowTarget>([
  ['workflow_missing_outputs', 'outputs'],
  ['workflow_missing_rollback_version', 'versions'],
])

export function hasAuthoringProblemTarget(problem: AuthoringProblem): boolean {
  return Boolean(problem.nodeId || problem.edgeId || workflowTargets.has(problem.code))
}

export function openAuthoringProblemsList(): void {
  requestAuthoringScope('problems')
  useWorkflowStore.getState().setActiveTab('inspector')
}

export function openAuthoringProblem(problem: AuthoringProblem): void {
  if (!hasAuthoringProblemTarget(problem)) {
    openAuthoringProblemsList()
    return
  }
  const { selectNode, selectEdge, setActiveTab } = useWorkflowStore.getState()
  if (problem.nodeId) {
    if (resilienceIssueCodes.has(problem.code)) requestResilienceFocus(problem.nodeId)
    else requestAuthoringFocus({ kind: 'node', id: problem.nodeId })
    selectNode(problem.nodeId)
    requestAuthoringScope('step')
  } else if (problem.edgeId) {
    requestAuthoringFocus({ kind: 'edge', id: problem.edgeId })
    selectEdge(problem.edgeId)
    requestAuthoringScope('step')
  } else {
    requestAuthoringScope('workflow', workflowTargets.get(problem.code))
  }
  setActiveTab('inspector')
}

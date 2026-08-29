import { InspectorPanel } from '@janusly/web'
import { graphEdges, graphNodes, runNodes, savedWorkflows, tools } from './_fixtures'

/**
 * The right-hand editor for whatever is selected on the canvas — one node or
 * one edge, never both. It renders a different form per step type (an `http`
 * step edits URL, method and timeout; a `tool` step picks from the tool catalog
 * and validates against that tool's input contract), and folds in the run's
 * node status so an author reads the last outcome next to the configuration
 * that produced it.
 *
 * `selectedNode` and `selectedEdge` are a pair: the unselected one is `null`.
 * The generated contract shows them as non-nullable because the extractor drops
 * nullable unions — see NOTES.md.
 */

const shared = {
  runNodes,
  validationIssues: [],
  tools,
  workflows: savedWorkflows,
  workflowNodes: graphNodes,
  workflowEdges: graphEdges,
  currentWorkflowId: 'wf_invoice_recon',
  currentWorkflowName: 'Invoice reconciliation',
  onUpdateNodeConfig: () => {},
  onUpdateNodeType: () => {},
  onUpdateEdgeCondition: () => {},
  onUpdateEdgeOnError: () => {},
  onInsertSnippet: () => {},
}

/** An HTTP step selected, with its last run outcome shown alongside. */
export function NodeSelected() {
  return <InspectorPanel {...shared} selectedNode={graphNodes[0]} selectedEdge={null} />
}

/**
 * A conditional edge selected. The condition uses the runtime's limited
 * grammar — dotted paths must start with `context.` or `inputs.` — and the
 * editor validates against exactly that parser, so an unsupported token is
 * flagged here rather than at run time.
 */
export function EdgeSelected() {
  return <InspectorPanel {...shared} selectedNode={null} selectedEdge={graphEdges[1]} />
}

/** A viewer sees the same configuration with every field withheld. */
export function ReadOnly() {
  return <InspectorPanel {...shared} selectedNode={graphNodes[0]} selectedEdge={null} readOnly />
}

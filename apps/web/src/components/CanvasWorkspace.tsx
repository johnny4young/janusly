/**
 * Lazy boundary that owns the React Flow provider for the workflow editor.
 *
 * `<ReactFlowProvider>` lives here (not at the app root) so `@xyflow/react`
 * — the heaviest dependency in the web bundle — is deferred off the boot
 * path: it ships in this component's own on-demand `CanvasWorkspace` chunk,
 * loaded only when the operator first leaves the home tab for a tab that
 * mounts the canvas. Home-landing users download zero React Flow.
 *
 * `App.tsx` renders this via `lazy()` + `<Suspense>` inside the
 * `workspace-canvas-wrapper`, which `getCanvasVisibility` keeps mounted for
 * every non-home tab (visible on canvas tabs, `display: none` on the rest).
 * Because the wrapper never unmounts across non-home navigation, the
 * `<ReactFlow>` instance — and thus the viewport (zoom + pan) — survives
 * cycles such as `inspector → operations → inspector`. A round-trip through
 * home unmounts the canvas, so it re-fits on the next mount.
 */

import { ReactFlowProvider, addEdge, applyEdgeChanges, applyNodeChanges } from '@xyflow/react'
import { useMemo } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import type { EdgeMouseHandler, NodeMouseHandler, OnConnect, OnEdgesChange, OnNodesChange } from '@xyflow/react'
import { WorkflowCanvas } from './WorkflowCanvas'
import { registerFlowOps } from '../store'
import { getRunWorkflowSnapshot, projectVisibleEdges, projectVisibleNodes, workflowToGraph } from '../canvas-projections'
import { useT } from '../i18n'
import type { RunNode, RunSummary, WorkflowGraphEdge, WorkflowGraphNode } from '../types'

// Hand the store React Flow's change-appliers as soon as this (lazy) chunk
// evaluates — before any canvas interaction can fire a reducer. Keeping the
// static import here (not in the boot-reachable store) is what holds
// @xyflow/react off the boot path.
registerFlowOps({ applyNodeChanges, applyEdgeChanges, addEdge })

/** Wrap the editor canvas in its React Flow provider; props pass straight
 *  through to `WorkflowCanvas`. */
export function CanvasWorkspace(props: ComponentProps<typeof WorkflowCanvas>) {
  return (
    <ReactFlowProvider>
      <WorkflowCanvas {...props} />
    </ReactFlowProvider>
  )
}

const ignoreNodeChanges: OnNodesChange<WorkflowGraphNode> = () => undefined
const ignoreEdgeChanges: OnEdgesChange<WorkflowGraphEdge> = () => undefined
const ignoreConnect: OnConnect = () => undefined
const ignoreNodeClick: NodeMouseHandler<WorkflowGraphNode> = () => undefined
const ignoreEdgeClick: EdgeMouseHandler<WorkflowGraphEdge> = () => undefined

/**
 * Immutable companion canvas for a persisted run snapshot. This uses a
 * separate provider/React Flow instance from the editor so observing a run can
 * never alter authoring selection, graph state, or the saved editor viewport.
 */
export function RunObservationWorkspace({ run, runNodes, panel }: {
  run: RunSummary
  runNodes: RunNode[]
  panel: ReactNode
}) {
  const { t } = useT()
  const graph = useMemo(() => {
    const snapshot = getRunWorkflowSnapshot(run.inputJson)
    return snapshot ? workflowToGraph(snapshot) : null
  }, [run.inputJson])
  const nodes = useMemo(
    () => graph
      ? projectVisibleNodes(graph.nodes, new Map(runNodes.map(node => [node.nodeId, node.status])), [], null)
      : [],
    [graph, runNodes],
  )
  const edges = useMemo(
    () => graph ? projectVisibleEdges(graph.edges, null) : [],
    [graph],
  )

  if (!graph) return <div data-layout="contextual">{panel}</div>

  return (
    <div data-layout="run-observation" data-testid="run-observation-workspace">
      <section className="run-observation-map" aria-label={t('canvas.runMap')}>
        <ReactFlowProvider>
          <WorkflowCanvas
            mode="observe"
            nodes={nodes}
            edges={edges}
            onNodesChange={ignoreNodeChanges}
            onEdgesChange={ignoreEdgeChanges}
            onConnect={ignoreConnect}
            onNodeClick={ignoreNodeClick}
            onEdgeClick={ignoreEdgeClick}
          />
        </ReactFlowProvider>
      </section>
      <div className="run-observation-panel">{panel}</div>
    </div>
  )
}

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
 * `workspace-canvas-wrapper`. `getCanvasVisibility` defers the first mount
 * until a canvas tab is actually visible (React Flow cannot measure a first
 * mount under `display: none`), then keeps it mounted for the rest of that
 * non-home workspace session. The `<ReactFlow>` instance — and thus viewport
 * zoom/pan — survives cycles such as `inspector → operations → inspector`.
 * A round-trip through home unmounts the canvas, so it re-fits on next use.
 */

import { ReactFlowProvider, addEdge, applyEdgeChanges, applyNodeChanges } from '@xyflow/react'
import { lazy, Suspense, useMemo, useState } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import type { EdgeMouseHandler, NodeMouseHandler, OnConnect, OnEdgesChange, OnNodesChange } from '@xyflow/react'
import '../styles/canvas.css'
import { WorkflowCanvas } from './WorkflowCanvas'
import { RunMapActionsContext, RunMapTotals, type RunMapActions } from './RunMapOverlay'
import type { RightPanelExecution } from './RightPanel'
import { registerFlowOps, useWorkflowStore } from '../store'
import { describeRecoveryError } from '../recovery-error-summary'
import { getRunWorkflowSnapshot, projectVisibleEdges, projectVisibleNodes, workflowToGraph } from '../canvas-projections'
import { refreshRunMap, useRunMap } from '../hooks/useRunMap'
import { projectRunMapOverlays, type RunMapNodeOverlay } from '../run-map'
import { getRunWorkflowIdentity, readHumanFormWaiting } from '../run-observability'
import { useT } from '../i18n'
import type { RunNode, RunSummary, WorkflowGraphEdge, WorkflowGraphNode } from '../types'

// From the run panel's chunk, which the run map always shows beside the canvas.
const HumanFormDialog = lazy(() => import('./RunsPanel').then(module => ({ default: module.HumanFormDialog })))
const RerunStepDialog = lazy(() => import('./RunsPanel').then(module => ({ default: module.RerunStepDialog })))

// Hand the store React Flow's change-appliers as soon as this (lazy) chunk
// evaluates — before any canvas interaction can fire a reducer. Keeping the
// static import here (not in the boot-reachable store) is what holds
// @xyflow/react off the boot path.
registerFlowOps({ applyNodeChanges, applyEdgeChanges, addEdge })

const NO_OVERLAYS: ReadonlyMap<string, RunMapNodeOverlay> = new Map()
const NO_PERMISSIONS: readonly string[] = []

function withOverlays(nodes: WorkflowGraphNode[], overlays: ReadonlyMap<string, RunMapNodeOverlay>): WorkflowGraphNode[] {
  if (overlays.size === 0) return nodes
  return nodes.map((node) => {
    const runMap = overlays.get(node.id)
    return runMap ? { ...node, data: { ...node.data, runMap } } : node
  })
}

/** The open run's map facts on the editor, only while it shows that run's workflow. */
function useEditorRunMapNodes(nodes: WorkflowGraphNode[], active: boolean): WorkflowGraphNode[] {
  const runId = useWorkflowStore(state => state.runId)
  const runDetail = useWorkflowStore(state => state.runDetail)
  const runNodes = useWorkflowStore(state => state.runNodes)
  const workflowId = useWorkflowStore(state => state.currentWorkflowId)
  const run = runDetail && runDetail.id === runId && getRunWorkflowIdentity(runDetail).id === workflowId ? runDetail : null
  const snapshot = useRunMap(active && run ? run.id : null)
  const overlays = useMemo(
    () => (run ? projectRunMapOverlays(snapshot, runNodes, run, false) : NO_OVERLAYS),
    [run, runNodes, snapshot],
  )
  return useMemo(() => withOverlays(nodes, overlays), [nodes, overlays])
}

/** Wrap the editor canvas in its React Flow provider; props pass straight
 *  through to `WorkflowCanvas`. */
export function CanvasWorkspace(props: ComponentProps<typeof WorkflowCanvas>) {
  const nodes = useEditorRunMapNodes(props.nodes, props.active !== false)
  return (
    <ReactFlowProvider>
      <WorkflowCanvas {...props} nodes={nodes} />
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
 * The run map adds time, cost, stuck and the decisions the viewer can take.
 */
export function RunObservationWorkspace({ run, runNodes, panel, onRecoverNode, permissions = NO_PERMISSIONS, execution }: {
  run: RunSummary
  runNodes: RunNode[]
  panel: ReactNode
  onRecoverNode?: (nodeId: string) => void
  permissions?: readonly string[]
  execution?: Pick<RightPanelExecution, 'onApproveNode' | 'onSubmitHumanForm' | 'onOpenRun'>
}) {
  const { t } = useT()
  const runId = run.id
  const snapshot = useRunMap(runId)
  const canStartRuns = permissions.includes('runs.start')
  const overlays = useMemo(
    () => projectRunMapOverlays(snapshot, runNodes, run, canStartRuns),
    [canStartRuns, run, runNodes, snapshot],
  )
  const graph = useMemo(() => {
    const snapshot = getRunWorkflowSnapshot(run.inputJson)
    return snapshot ? workflowToGraph(snapshot) : null
  }, [run.inputJson])
  const nodes = useMemo(
    () => {
      if (!graph) return []
      const failed = new Map(runNodes.filter((node) => node.status === 'failed').map((node) => [node.nodeId, node]))
      const projected = projectVisibleNodes(graph.nodes, new Map(runNodes.map(node => [node.nodeId, node.status])), [], null)
        .map((node) => {
          const run = failed.get(node.id)
          if (!run) return node
          const digest = describeRecoveryError(run.errorJson, node.data.type)
          return {
            ...node,
            data: {
              ...node.data,
              errorSummary: digest.dnsHost ? t('dlq.errorSummary.dnsHost', { host: digest.dnsHost }) : digest.message,
              onRecover: onRecoverNode && (() => onRecoverNode(node.id)),
            },
          }
        })
      return withOverlays(projected, overlays)
    },
    [graph, onRecoverNode, overlays, runNodes, t],
  )
  const edges = useMemo(
    () => graph ? projectVisibleEdges(graph.edges, null) : [],
    [graph],
  )

  const [pendingNodeId, setPendingNodeId] = useState<string | null>(null)
  const [form, setForm] = useState<{ nodeId: string; errors: string[]; submitting: boolean } | null>(null)
  const [rerunNodeId, setRerunNodeId] = useState<string | null>(null)
  const actions = useMemo<RunMapActions | null>(() => execution ? {
    pendingNodeId,
    decide: (nodeId, choice) => {
      const decision = overlays.get(nodeId)?.decision
      if (!decision || decision.kind === 'human_form' || (decision.kind === 'approval' && choice === 'deny')) return
      setPendingNodeId(nodeId)
      const toolDecision = decision.kind === 'tool_approval'
        ? { approvalId: decision.approvalId, paramsDigest: decision.paramsDigest, decision: choice }
        : undefined
      void Promise.resolve(execution.onApproveNode(nodeId, toolDecision) as unknown).finally(() => {
        setPendingNodeId(current => (current === nodeId ? null : current))
        refreshRunMap(runId)
      })
    },
    openForm: nodeId => setForm({ nodeId, errors: [], submitting: false }),
    rerun: setRerunNodeId,
    openRun: (childRunId) => { void execution.onOpenRun(childRunId) },
  } : null, [execution, overlays, pendingNodeId, runId])
  const summary = useMemo(
    () => snapshot && <RunMapTotals map={snapshot.map} overlays={overlays} />,
    [overlays, snapshot],
  )
  const formNode = form ? runNodes.find(node => node.nodeId === form.nodeId) : undefined
  const formWaiting = formNode ? readHumanFormWaiting(formNode) : null

  if (!graph) return <div data-layout="contextual">{panel}</div>

  return (
    <div data-layout="run-observation" data-testid="run-observation-workspace">
      <section className="run-observation-map" aria-label={t('canvas.runMap')}>
        <ReactFlowProvider>
          <RunMapActionsContext.Provider value={actions}>
            <WorkflowCanvas
              mode="observe"
              nodes={nodes}
              edges={edges}
              onNodesChange={ignoreNodeChanges}
              onEdgesChange={ignoreEdgeChanges}
              onConnect={ignoreConnect}
              onNodeClick={ignoreNodeClick}
              onEdgeClick={ignoreEdgeClick}
              summary={summary}
            />
          </RunMapActionsContext.Provider>
        </ReactFlowProvider>
      </section>
      <div className="run-observation-panel">{panel}</div>
      {execution && form && formWaiting && (
        <Suspense fallback={null}>
          <HumanFormDialog
            key={form.nodeId}
            title={formWaiting.title}
            description={formWaiting.description}
            schema={formWaiting.schema}
            initialValues={formWaiting.initialValues}
            serverErrors={form.errors}
            submitting={form.submitting}
            onCancel={() => setForm(null)}
            onSubmit={async (input) => {
              setForm({ ...form, errors: [], submitting: true })
              const errors = await execution.onSubmitHumanForm(form.nodeId, input, formWaiting.resumeToken)
              refreshRunMap(runId)
              setForm(errors && errors.length > 0 ? { ...form, errors, submitting: false } : null)
            }}
          />
        </Suspense>
      )}
      {rerunNodeId && (
        <Suspense fallback={null}>
          <RerunStepDialog runId={runId} nodeId={rerunNodeId} onClose={() => setRerunNodeId(null)} />
        </Suspense>
      )}
    </div>
  )
}

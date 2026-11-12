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
import { lazy, Suspense, useMemo, useRef, useState } from 'react'
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
import { getRunWaitingInfo, getRunWorkflowIdentity, getToolApprovalRequest, readHumanFormWaiting } from '../run-observability'
import { useConfirm } from './ConfirmDialog'
import { useAliveRef } from '../hooks/useAliveRef'
import { useT } from '../i18n'
import type { RunNode, RunSummary, WorkflowGraphEdge, WorkflowGraphNode } from '../types'

// From the run panel's chunk, which the run map always shows beside the canvas.
const HumanFormDialog = lazy(() => import('./RunsPanel').then(module => ({ default: module.HumanFormDialog })))
const RerunStepDialog = lazy(() => import('./RunsPanel').then(module => ({ default: module.RerunStepDialog })))
const ToolApprovalDetails = lazy(() => import('./RunsPanel').then(module => ({ default: module.ToolApprovalDetails })))

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
  const runWorkflowId = runDetail?.id === runId ? getRunWorkflowIdentity(runDetail).id : null
  const run = runDetail && runWorkflowId !== null && runWorkflowId === workflowId ? runDetail : null
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
  const graph = useMemo(() => {
    const snapshot = getRunWorkflowSnapshot(run.inputJson)
    return snapshot ? workflowToGraph(snapshot) : null
  }, [run.inputJson])
  const snapshot = useRunMap(graph ? runId : null)
  const canStartRuns = permissions.includes('runs.start')
  const overlays = useMemo(
    () => projectRunMapOverlays(snapshot, runNodes, run, canStartRuns),
    [canStartRuns, run, runNodes, snapshot],
  )
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
  const [form, setForm] = useState<{ nodeId: string; resumeToken: string; errors: string[]; submitting: boolean } | null>(null)
  const [rerunNodeId, setRerunNodeId] = useState<string | null>(null)
  // App rebuilds `execution` every render; depend on its stable callbacks only.
  const onApproveNode = execution?.onApproveNode
  const onSubmitHumanForm = execution?.onSubmitHumanForm
  const onOpenRun = execution?.onOpenRun
  const confirm = useConfirm()
  const alive = useAliveRef()
  const live = useRef({ overlays, runNodes })
  live.current = { overlays, runNodes }
  const actions = useMemo<RunMapActions | null>(() => onApproveNode && onOpenRun ? {
    pendingNodeId,
    // The person decides the request the dialog showed; a request that changed meanwhile is shown again.
    decide: async function review(nodeId, choice, step, changed = false) {
      const decision = live.current.overlays.get(nodeId)?.decision
      if (!decision || decision.kind === 'human_form' || (decision.kind === 'approval' && choice === 'deny')) return
      const node = live.current.runNodes.find(candidate => candidate.nodeId === nodeId)
      const request = node && getToolApprovalRequest(node)
      const confirmed = await confirm({
        title: t(choice === 'approve' ? 'canvas.runMap.approveAria' : 'canvas.runMap.denyAria', { step }),
        body: changed ? t('canvas.runMap.decisionChanged') : (node && getRunWaitingInfo(node).title) ?? step,
        details: request && (
          <>
            <code data-testid={`tool-approval-tool-${nodeId}`}>{request.tool}</code>
            <Suspense fallback={null}><ToolApprovalDetails nodeId={nodeId} request={request} /></Suspense>
          </>
        ),
        confirmLabel: t(`rightPanel.runs.toolApproval.${choice}`),
        tone: choice === 'deny' ? 'danger' : 'default',
      })
      if (!confirmed || !alive.current) return
      const current = live.current.overlays.get(nodeId)?.decision
      const unchanged = current?.kind === 'tool_approval'
        ? request?.approvalId === current.approvalId && request.paramsDigest === current.paramsDigest
        : current?.kind === 'approval' && !request
      if (!unchanged) {
        refreshRunMap(runId)
        return review(nodeId, choice, step, true)
      }
      setPendingNodeId(nodeId)
      const toolDecision = request ? { approvalId: request.approvalId, paramsDigest: request.paramsDigest, decision: choice } : undefined
      await Promise.resolve(onApproveNode(nodeId, toolDecision)).finally(() => {
        setPendingNodeId(current => (current === nodeId ? null : current))
        refreshRunMap(runId)
      })
    },
    openForm: (nodeId) => {
      const decision = live.current.overlays.get(nodeId)?.decision
      if (decision?.kind === 'human_form') setForm({ nodeId, resumeToken: decision.resumeToken, errors: [], submitting: false })
    },
    rerun: setRerunNodeId,
    openRun: (childRunId) => { void onOpenRun(childRunId) },
  } : null, [alive, confirm, onApproveNode, onOpenRun, pendingNodeId, runId, t])
  const summary = useMemo(
    () => snapshot && <RunMapTotals map={snapshot.map} overlays={overlays} />,
    [overlays, snapshot],
  )
  const formNode = form ? runNodes.find(node => node.nodeId === form.nodeId) : undefined
  const liveForm = formNode ? readHumanFormWaiting(formNode) : null
  // A form is bound to the token it opened with; a new token is a new form.
  const formWaiting = liveForm && liveForm.resumeToken === form?.resumeToken ? liveForm : null
  if (form && !form.submitting && !formWaiting) setForm(null)

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
      {onSubmitHumanForm && form && formWaiting && (
        <Suspense fallback={null}>
          <HumanFormDialog
            key={form.resumeToken}
            title={formWaiting.title}
            description={formWaiting.description}
            schema={formWaiting.schema}
            initialValues={formWaiting.initialValues}
            serverErrors={form.errors}
            submitting={form.submitting}
            onCancel={() => setForm(null)}
            onSubmit={async (input) => {
              const { nodeId, resumeToken } = form
              setForm({ ...form, errors: [], submitting: true })
              let errors: string[] | undefined
              try {
                errors = await onSubmitHumanForm(nodeId, input, resumeToken)
              } finally {
                refreshRunMap(runId)
                // A cancel during the submit closed the dialog; keep it closed.
                setForm(current => current?.resumeToken !== resumeToken ? current : errors && errors.length > 0 ? { ...current, errors, submitting: false } : null)
              }
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

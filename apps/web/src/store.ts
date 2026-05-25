/**
 * Zustand store — single global state for Janusly Studio.
 *
 * Holds the workflow being edited (nodes, edges), the active run (runId,
 * runNodes, events, paginated cursor + hasMore), tabs, toasts,
 * Supabase session, and `platformVersion` — the cross-panel reactivity
 * counter that mutations bump so independent panels refetch (AGENTS.md).
 *
 * Used by every component under `apps/web/src/`. Lives in one file
 * intentionally; the project's small enough that splitting the store into
 * slices adds noise without value.
 *
 * Invariants:
 * - `bumpPlatformVersion()` is the cross-panel reactivity hook. Every
 *   server-mutating action (save, run start, terminal run, member
 *   invite/remove, DLQ replay) must call it so independent panels see the
 *   change. Calls within `BUMP_COALESCE_MS` (100ms) collapse to ONE
 *   subscriber notification via trailing-edge debounce — a chained
 *   mutation that fires N internal bumps still triggers one refresh
 *   wave across the ~20 subscribers.
 * - `mergeEvents(events)` deduplicates by id and re-sorts by `(createdAt,
 *   id)`. It's the path polling uses; `setEvents` is the hard-replace path
 *   that resets the cursor. Don't conflate the two.
 * - Pagination cursor + hasMore live alongside the events array so a
 *   "Load older events" button can fetch backwards without losing the
 *   already-loaded tail.
 */

import { create } from 'zustand'
import type { Connection, OnEdgesChange, OnNodesChange } from '@xyflow/react'
import { applyEdgeChanges, applyNodeChanges, addEdge } from '@xyflow/react'
import type { Session, User } from '@supabase/supabase-js'
import type { ActiveTab, JsonObject, RunEvent, RunNode, WorkflowDefinition, WorkflowGraphEdge, WorkflowGraphNode } from './types'
import { getNodePreset } from './constants'
import { t } from './i18n/runtime'

type StreamStatus = 'idle' | 'connecting' | 'connected' | 'closed' | 'error'
type ToastTone = 'success' | 'error' | 'info'
type Toast = { id: string; message: string; tone: ToastTone }
type BudgetBlockedEnvelope = {
  monthlyUsdSpent?: number
  monthlyUsdLimit?: number | null
  resolvedScope?: 'org' | 'workflow' | null
  exceededAt?: 'org' | 'workflow' | null
  policy?: 'warn' | 'block'
}

type WorkflowStore = {
  session: Session | null
  user: User | null
  userId: string | null
  orgId: string | null
  authReady: boolean

  currentWorkflowId: string
  currentWorkflowName: string
  /** Declared input shape — surfaced in the Inspector + validated at run start. */
  currentWorkflowInputs: WorkflowDefinition['inputs']
  /** Declared output projection map — engine renders templates at terminal status. */
  currentWorkflowOutputs: WorkflowDefinition['outputs']
  nodes: WorkflowGraphNode[]
  edges: WorkflowGraphEdge[]
  selectedNodeId: string | null
  selectedEdgeId: string | null

  runId: string | null
  runNodes: RunNode[]
  events: RunEvent[]
  eventsCursor: string | null
  eventsHasMore: boolean
  activeTab: ActiveTab
  streamStatus: StreamStatus
  toasts: Toast[]
  platformVersion: number
  /** Most recent HTTP 402 budget-block envelope from any /ai/* route. The
   *  AI Studio top-of-canvas BudgetBlockedBanner reads this slot; the
   *  api() wrapper sets it on every 402; clearBudgetBlocked() unsets. */
  budgetBlocked: BudgetBlockedEnvelope | null

  setAuth: (payload: { session: Session | null; user: User | null; userId: string | null; orgId: string | null }) => void
  clearAuth: () => void
  setAuthReady: (ready: boolean) => void

  addNode: (type: string) => void
  hydrateWorkflow: (workflow: WorkflowDefinition) => void
  getWorkflowJson: () => WorkflowDefinition
  newWorkflow: () => void
  setWorkflowName: (name: string) => void
  setNodes: (nodes: WorkflowGraphNode[]) => void
  setEdges: (edges: WorkflowGraphEdge[]) => void
  onNodesChange: OnNodesChange
  onEdgesChange: OnEdgesChange
  connect: (connection: Connection) => void
  selectNode: (id: string | null) => void
  selectEdge: (id: string | null) => void
  updateSelectedNodeConfig: (config: JsonObject) => void
  updateSelectedNodeType: (type: string) => void
  updateEdgeCondition: (id: string, condition: string | null) => void

  setRunId: (id: string | null) => void
  setRunNodes: (nodes: RunNode[]) => void
  addEvents: (events: RunEvent[]) => void
  setEvents: (events: RunEvent[]) => void
  setEventsPagination: (cursor: string | null, hasMore: boolean) => void
  setActiveTab: (tab: ActiveTab) => void
  setStreamStatus: (status: StreamStatus) => void
  resetRun: () => void
  addToast: (message: string, tone?: ToastTone) => void
  removeToast: (id: string) => void
  setBudgetBlocked: (envelope: BudgetBlockedEnvelope | null) => void
  clearBudgetBlocked: () => void
  bumpPlatformVersion: () => void
}

/**
 * Trailing-edge debounce window for `bumpPlatformVersion()`. Bumps
 * arriving within this window reset the timer; the final fire does ONE
 * `set(...)`. 100ms is below the perceptible threshold for
 * user-initiated mutations (~6 frames at 60Hz) and collapses bursts
 * from chained mutations into a single refresh wave.
 */
const BUMP_COALESCE_MS = 100
let pendingBumpTimer: ReturnType<typeof setTimeout> | null = null

const initialNodes: WorkflowGraphNode[] = [
  { id: '1', position: { x: 0, y: 0 }, data: { label: 'HTTP', type: 'http', config: { url: 'https://api.github.com' } } },
  { id: '2', position: { x: 260, y: 90 }, data: { label: 'MULTI_AGENT', type: 'multi_agent', config: getNodePreset('multi_agent') } },
]

const initialEdges: WorkflowGraphEdge[] = [{ id: 'e1-2', source: '1', target: '2', data: {} }]

function graphToWorkflow(
  id: string,
  name: string,
  nodes: WorkflowGraphNode[],
  edges: WorkflowGraphEdge[],
  inputs: WorkflowDefinition['inputs'],
  outputs: WorkflowDefinition['outputs'],
): WorkflowDefinition {
  return {
    id,
    name,
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.data.type,
      config: node.data.config ?? {},
    })),
    edges: edges.map((edge) => ({
      from: edge.source,
      to: edge.target,
      condition: edge.data?.condition || undefined,
    })),
    ...(inputs ? { inputs } : {}),
    ...(outputs ? { outputs } : {}),
  }
}

export const useWorkflowStore = create<WorkflowStore>((set, get) => ({
  session: null,
  user: null,
  userId: null,
  orgId: null,
  authReady: false,

  currentWorkflowId: 'ui-test',
  currentWorkflowName: t('workflow.sampleName') as string,
  currentWorkflowInputs: undefined,
  currentWorkflowOutputs: undefined,
  nodes: initialNodes,
  edges: initialEdges,
  selectedNodeId: null,
  selectedEdgeId: null,
  runId: null,
  runNodes: [],
  events: [],
  eventsCursor: null,
  eventsHasMore: false,
  // The Recovery Center is the authenticated landing page. The operator's
  // most frequent job is triaging failed runs / pending approvals / cluster
  // recovery — surfacing those tiles first beats opening the canvas blind.
  // The builder is one click away via the Workspace-views sidebar.
  activeTab: 'home',
  streamStatus: 'idle',
  toasts: [],
  platformVersion: 0,
  budgetBlocked: null,

  setAuth: ({ session, user, userId, orgId }) => set({ session, user, userId, orgId, authReady: true }),
  clearAuth: () => set({ session: null, user: null, userId: null, orgId: null, authReady: true }),
  setAuthReady: (authReady) => set({ authReady }),

  addNode: (type) => {
    const id = crypto.randomUUID().slice(0, 8)
    set((state) => ({
      nodes: state.nodes.concat({
        id,
        position: { x: 120 + state.nodes.length * 80, y: 120 + state.nodes.length * 40 },
        data: { label: type.toUpperCase(), type, config: getNodePreset(type) },
      })
    }))
  },

  hydrateWorkflow: (workflow) => {
    set({
      currentWorkflowId: workflow.id ?? 'ui-test',
      currentWorkflowName: workflow.name ?? workflow.id ?? (t('workflow.defaultName') as string),
      currentWorkflowInputs: workflow.inputs,
      currentWorkflowOutputs: workflow.outputs,
      nodes: (workflow.nodes ?? []).map((node, index) => ({
        id: node.id,
        position: { x: 80 + index * 230, y: 80 + (index % 3) * 120 },
        data: { label: String(node.type).toUpperCase(), type: node.type, config: node.config ?? {} },
      })),
      edges: (workflow.edges ?? []).map((edge, index) => ({
        id: `e${index}`,
        source: edge.from,
        target: edge.to,
        label: edge.condition ? 'condition' : undefined,
        animated: Boolean(edge.condition),
        data: { condition: edge.condition },
      })),
      selectedNodeId: null,
      selectedEdgeId: null,
      events: [],
      eventsCursor: null,
      eventsHasMore: false,
      runNodes: [],
      runId: null,
    })
  },

  getWorkflowJson: () => {
    const state = get()
    return graphToWorkflow(
      state.currentWorkflowId,
      state.currentWorkflowName,
      state.nodes,
      state.edges,
      state.currentWorkflowInputs,
      state.currentWorkflowOutputs,
    )
  },

  newWorkflow: () => {
    const id = `workflow_${crypto.randomUUID().slice(0, 8)}`
    set({
      currentWorkflowId: id,
      currentWorkflowName: t('workflow.defaultName') as string,
      currentWorkflowInputs: undefined,
      currentWorkflowOutputs: undefined,
      nodes: [],
      edges: [],
      selectedNodeId: null,
      selectedEdgeId: null,
      events: [],
      eventsCursor: null,
      eventsHasMore: false,
      runNodes: [],
      runId: null,
      activeTab: 'copilot',
    })
  },

  setWorkflowName: (currentWorkflowName) => set({ currentWorkflowName }),
  setNodes: (nodes) => set({ nodes }),
  setEdges: (edges) => set({ edges }),
  onNodesChange: (changes) => set((state) => ({ nodes: applyNodeChanges(changes, state.nodes) })),
  onEdgesChange: (changes) => set((state) => ({ edges: applyEdgeChanges(changes, state.edges) })),
  connect: (connection) => set((state) => ({ edges: addEdge({ ...connection, data: {} }, state.edges) })),

  selectNode: (id) => set({ selectedNodeId: id, selectedEdgeId: null }),
  selectEdge: (id) => set({ selectedEdgeId: id, selectedNodeId: null }),

  updateSelectedNodeConfig: (config) => {
    const selectedNodeId = get().selectedNodeId
    if (!selectedNodeId) return
    set((state) => ({
      nodes: state.nodes.map((node) => node.id === selectedNodeId ? { ...node, data: { ...node.data, config } } : node)
    }))
  },

  updateSelectedNodeType: (type) => {
    const selectedNodeId = get().selectedNodeId
    if (!selectedNodeId) return
    set((state) => ({
      nodes: state.nodes.map((node) => node.id === selectedNodeId
        ? { ...node, data: { label: type.toUpperCase(), type, config: getNodePreset(type) } }
        : node)
    }))
  },

  updateEdgeCondition: (id, condition) => set((state) => ({
    edges: state.edges.map((edge) => edge.id === id
      ? {
          ...edge,
          label: condition ? 'condition' : undefined,
          animated: Boolean(condition),
          data: { ...edge.data, condition: condition ?? undefined },
        }
      : edge),
  })),

  setRunId: (id) => set({ runId: id }),
  setRunNodes: (nodes) => set({ runNodes: nodes }),
  setEvents: (events) => set({ events }),
  setEventsPagination: (eventsCursor, eventsHasMore) => set({ eventsCursor, eventsHasMore }),

  addEvents: (incoming) => set((state) => {
    const keyOf = (event: RunEvent) => event.id ?? `${event.type}:${event.nodeId}:${event.createdAt}`
    const merged = new Map(state.events.map((event) => [keyOf(event), event]))
    for (const event of incoming) merged.set(keyOf(event), event)
    const events = [...merged.values()].sort((a, b) => {
      const at = (a.createdAt ?? '').localeCompare(b.createdAt ?? '')
      if (at !== 0) return at
      return (a.id ?? '').localeCompare(b.id ?? '')
    })
    return { events }
  }),

  setActiveTab: (tab) => set({ activeTab: tab }),
  setStreamStatus: (streamStatus) => set({ streamStatus }),
  resetRun: () => set({ runId: null, runNodes: [], events: [], eventsCursor: null, eventsHasMore: false, streamStatus: 'idle' }),
  addToast: (message, tone = 'info') => {
    const id = crypto.randomUUID()
    set((state) => ({ toasts: [...state.toasts, { id, message, tone }] }))
    setTimeout(() => get().removeToast(id), 3500)
  },
  removeToast: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
  bumpPlatformVersion: () => {
    if (pendingBumpTimer !== null) clearTimeout(pendingBumpTimer)
    pendingBumpTimer = setTimeout(() => {
      pendingBumpTimer = null
      set((state) => ({ platformVersion: state.platformVersion + 1 }))
    }, BUMP_COALESCE_MS)
  },
  setBudgetBlocked: (envelope) => set({ budgetBlocked: envelope }),
  clearBudgetBlocked: () => set({ budgetBlocked: null }),
}))

/**
 * Test-only: cancel any pending coalesced bump and reset the module
 * timer state. Tests using `vi.useFakeTimers()` call this in
 * `afterEach` so a previous case's queued bump doesn't fire into the
 * next one.
 *
 * @internal — not part of the public surface; production code never
 * imports this.
 */
export function __resetBumpCoalesceForTests(): void {
  if (pendingBumpTimer !== null) {
    clearTimeout(pendingBumpTimer)
    pendingBumpTimer = null
  }
}

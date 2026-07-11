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
import type { Session, User } from '@supabase/supabase-js'
import type { ActiveTab, JsonObject, RunEvent, RunNode, WorkflowDefinition, WorkflowGraphEdge, WorkflowGraphNode } from './types'
import type { OnboardingState } from '@janusly/shared/src/onboarding'
import { getNodePreset } from './constants'
import { t } from './i18n/runtime'

/**
 * React Flow's change-appliers, registered lazily by `CanvasWorkspace` when
 * the editor canvas chunk first loads. They live in the deferred
 * `@xyflow/react` chunk, so importing them statically here would drag the
 * (heavy) React Flow renderer back onto the boot path. The canvas must be
 * mounted before any node-drag / edge-connect can fire a reducer, so
 * `flowOps` is always populated by the time the three change reducers run;
 * the `return state` guard is a defensive no-op for the impossible
 * "change before canvas mount" case.
 */
type FlowOps = Pick<typeof import('@xyflow/react'), 'applyNodeChanges' | 'applyEdgeChanges' | 'addEdge'>
let flowOps: FlowOps | null = null
export function registerFlowOps(ops: FlowOps): void {
  flowOps = ops
}

type StreamStatus = 'idle' | 'connecting' | 'connected' | 'closed' | 'error'
/**
 * How the active run's timeline is being kept fresh:
 * - `'idle'`   — no active run, or not yet started.
 * - `'sse'`    — the live SSE stream is connected (the "Live" pill is green).
 * - `'polling'`— SSE is unavailable/blocked; the 1.5s `/status` poll is the
 *                fallback updater (the pill shows amber "Polling").
 */
type StreamTransport = 'idle' | 'sse' | 'polling'
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
  /**
   * Whether the current workflow exists server-side. False for the initial
   * sample draft and after `newWorkflow()`; true once loaded from the server
   * or successfully saved. Health/metadata lookups skip unsaved drafts so a
   * never-saved workflow doesn't 404 the health/metadata endpoints on load.
   */
  currentWorkflowSaved: boolean
  /**
   * Whether the canvas holds semantic edits not yet persisted as a workflow
   * version. False for the untouched sample and right after hydrate/new/save;
   * true after any node/edge/config/name mutation (position drags don't count —
   * layout isn't serialized). Drives the unsaved-work guards
   * (confirm-before-replace, beforeunload) and the local draft autosave.
   */
  workflowDirty: boolean
  /** Monotonic serialized-workflow revision. Canvas position/selection changes
   *  never increment it; authoring checks use it to invalidate stale findings. */
  workflowRevision: number
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
  streamTransport: StreamTransport
  toasts: Toast[]
  platformVersion: number
  /** Most recent HTTP 402 budget-block envelope from any /ai/* route. The
   *  AI Studio top-of-canvas BudgetBlockedBanner reads this slot; the
   *  api() wrapper sets it on every 402; clearBudgetBlocked() unsets. */
  budgetBlocked: BudgetBlockedEnvelope | null
  /** Latest "first recovered run" onboarding snapshot. The OnboardingBanner
   *  overlay self-fetches `/onboarding` on mount + every platformVersion bump
   *  and stores the result here; renders only while `status === 'active'`. */
  onboarding: OnboardingState | null

  setAuth: (payload: { session: Session | null; user: User | null; userId: string | null; orgId: string | null }) => void
  clearAuth: () => void
  setAuthReady: (ready: boolean) => void

  addNode: (type: string) => void
  hydrateWorkflow: (workflow: WorkflowDefinition, options?: { saved?: boolean; dirty?: boolean }) => void
  getWorkflowJson: () => WorkflowDefinition
  newWorkflow: () => void
  /** Mark the current workflow as persisted server-side (after a successful save). */
  markWorkflowSaved: () => void
  /** Force the dirty flag on — used after restoring a local draft (the restored content isn't server-side). */
  markWorkflowDirty: () => void
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
  mergeRunNode: (node: RunNode) => void
  addEvents: (events: RunEvent[]) => void
  setEvents: (events: RunEvent[]) => void
  setEventsPagination: (cursor: string | null, hasMore: boolean) => void
  setActiveTab: (tab: ActiveTab) => void
  setStreamStatus: (status: StreamStatus) => void
  setStreamTransport: (transport: StreamTransport) => void
  resetRun: () => void
  addToast: (message: string, tone?: ToastTone) => void
  removeToast: (id: string) => void
  setBudgetBlocked: (envelope: BudgetBlockedEnvelope | null) => void
  clearBudgetBlocked: () => void
  setOnboarding: (state: OnboardingState | null) => void
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

// Toast auto-dismiss windows. Errors stay ~2x longer because they typically
// carry an action the reader must take before the toast disappears.
const TOAST_TTL_DEFAULT_MS = 3500
const TOAST_TTL_ERROR_MS = 6000

// Persist the operator's last top-level tab so a refresh restores context
// instead of dropping back to Home. The stored value is validated against the
// known set; anything unknown/removed falls back to Home. Keep PERSISTED_TABS
// in sync with the ActiveTab union in ./types (drift just disables restore for
// the new tab — it never throws).
const ACTIVE_TAB_KEY = 'janusly:activeTab'
const PERSISTED_TABS: readonly ActiveTab[] = [
  'home', 'workflows', 'members', 'copilot', 'marketplace', 'templates',
  'packs', 'credentials', 'inspector', 'runs', 'reasoning', 'multiAgent', 'operations', 'experiments',
]
function readStoredActiveTab(): ActiveTab {
  try {
    const raw = window.localStorage.getItem(ACTIVE_TAB_KEY)
    return raw && (PERSISTED_TABS as readonly string[]).includes(raw) ? (raw as ActiveTab) : 'home'
  } catch {
    return 'home'
  }
}
function persistActiveTab(tab: ActiveTab): void {
  try {
    window.localStorage.setItem(ACTIVE_TAB_KEY, tab)
  } catch {
    // localStorage may be unavailable (Safari private mode); ignore.
  }
}

// `data.label` is intentionally empty — `WorkflowStepNode` resolves
// the human label via `getNodeLabel(type)` at render time, which
// re-evaluates through the i18n runtime on locale toggles. Leaving
// the field empty lets the OR-fallback (`data.label || ...`) kick in.
const initialNodes: WorkflowGraphNode[] = [
  { id: '1', position: { x: 0, y: 0 }, data: { label: '', type: 'http', config: { url: 'https://api.github.com' } } },
  { id: '2', position: { x: 260, y: 90 }, data: { label: '', type: 'multi_agent', config: getNodePreset('multi_agent') } },
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
  currentWorkflowSaved: false,
  workflowDirty: false,
  workflowRevision: 0,
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
  // The Recovery Center is the authenticated landing page (the operator's most
  // frequent job is triaging failed runs / pending approvals / cluster
  // recovery). When the operator has navigated elsewhere, the last tab is
  // restored from localStorage so a refresh doesn't drop them back to Home.
  activeTab: readStoredActiveTab(),
  streamStatus: 'idle',
  streamTransport: 'idle',
  toasts: [],
  platformVersion: 0,
  budgetBlocked: null,
  onboarding: null,

  setAuth: ({ session, user, userId, orgId }) => set({ session, user, userId, orgId, authReady: true }),
  clearAuth: () => set({ session: null, user: null, userId: null, orgId: null, authReady: true }),
  setAuthReady: (authReady) => set({ authReady }),

  addNode: (type) => {
    const id = crypto.randomUUID().slice(0, 8)
    set((state) => ({
      workflowDirty: true,
      workflowRevision: state.workflowRevision + 1,
      nodes: state.nodes.concat({
        id,
        position: { x: 120 + state.nodes.length * 80, y: 120 + state.nodes.length * 40 },
        // Leave `data.label` empty so the canvas component resolves the
        // human label via `getNodeLabel(type)` at render time.
        data: { label: '', type, config: getNodePreset(type) },
      })
    }))
  },

  hydrateWorkflow: (workflow, options) => {
    const saved = options?.saved ?? true
    const dirty = options?.dirty ?? false
    set((state) => ({
      currentWorkflowId: workflow.id ?? 'ui-test',
      currentWorkflowName: workflow.name ?? workflow.id ?? (t('workflow.defaultName') as string),
      currentWorkflowSaved: saved,
      workflowDirty: dirty,
      currentWorkflowInputs: workflow.inputs,
      currentWorkflowOutputs: workflow.outputs,
      nodes: (workflow.nodes ?? []).map((node, index) => ({
        id: node.id,
        position: { x: 80 + index * 230, y: 80 + (index % 3) * 120 },
        // `data.label` stays empty; `WorkflowStepNode` resolves the
        // human label via `getNodeLabel(type)` so a locale toggle
        // re-renders the leaf without re-projecting the full graph.
        data: { label: '', type: node.type, config: node.config ?? {} },
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
      workflowRevision: state.workflowRevision + 1,
    }))
  },

  markWorkflowSaved: () => set({ currentWorkflowSaved: true, workflowDirty: false }),
  markWorkflowDirty: () => set({ workflowDirty: true }),

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
    set((state) => ({
      currentWorkflowId: id,
      currentWorkflowName: t('workflow.defaultName') as string,
      currentWorkflowSaved: false,
      workflowDirty: false,
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
      workflowRevision: state.workflowRevision + 1,
    }))
  },

  setWorkflowName: (currentWorkflowName) => set((state) => ({ currentWorkflowName, workflowDirty: true, workflowRevision: state.workflowRevision + 1 })),
  setNodes: (nodes) => set((state) => ({ nodes, workflowDirty: true, workflowRevision: state.workflowRevision + 1 })),
  setEdges: (edges) => set((state) => ({ edges, workflowDirty: true, workflowRevision: state.workflowRevision + 1 })),
  // Position/dimension/selection changes are layout-only (never serialized by
  // `graphToWorkflow`) — only a node/edge REMOVAL is a semantic edit here.
  onNodesChange: (changes) => set((state) => (flowOps
    ? {
        nodes: flowOps.applyNodeChanges(changes, state.nodes),
        ...(changes.some((c) => c.type === 'remove')
          ? { workflowDirty: true, workflowRevision: state.workflowRevision + 1 }
          : {}),
      }
    : state)),
  onEdgesChange: (changes) => set((state) => (flowOps
    ? {
        edges: flowOps.applyEdgeChanges(changes, state.edges),
        ...(changes.some((c) => c.type === 'remove')
          ? { workflowDirty: true, workflowRevision: state.workflowRevision + 1 }
          : {}),
      }
    : state)),
  connect: (connection) => set((state) => (flowOps
    ? {
        edges: flowOps.addEdge({ ...connection, data: {} }, state.edges),
        workflowDirty: true,
        workflowRevision: state.workflowRevision + 1,
      }
    : state)),

  selectNode: (id) => set({ selectedNodeId: id, selectedEdgeId: null }),
  selectEdge: (id) => set({ selectedEdgeId: id, selectedNodeId: null }),

  updateSelectedNodeConfig: (config) => {
    const selectedNodeId = get().selectedNodeId
    if (!selectedNodeId) return
    set((state) => ({
      workflowDirty: true,
      workflowRevision: state.workflowRevision + 1,
      nodes: state.nodes.map((node) => node.id === selectedNodeId ? { ...node, data: { ...node.data, config } } : node)
    }))
  },

  updateSelectedNodeType: (type) => {
    const selectedNodeId = get().selectedNodeId
    if (!selectedNodeId) return
    set((state) => ({
      workflowDirty: true,
      workflowRevision: state.workflowRevision + 1,
      nodes: state.nodes.map((node) => node.id === selectedNodeId
        // Same as `addNode` / `hydrateWorkflow`: leave `data.label`
        // empty so the canvas resolves it via `getNodeLabel(type)`.
        ? { ...node, data: { label: '', type, config: getNodePreset(type) } }
        : node)
    }))
  },

  updateEdgeCondition: (id, condition) => set((state) => ({
    workflowDirty: true,
    workflowRevision: state.workflowRevision + 1,
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
  mergeRunNode: (incoming) => set((state) => {
    const index = state.runNodes.findIndex((node) => node.nodeId === incoming.nodeId)
    if (index === -1) return { runNodes: [...state.runNodes, incoming] }
    const runNodes = state.runNodes.map((node) => {
      if (node.nodeId !== incoming.nodeId) return node
      const next: RunNode = { ...node, status: incoming.status }
      if ('stateJson' in incoming) next.stateJson = incoming.stateJson ?? null
      if ('errorJson' in incoming) next.errorJson = incoming.errorJson ?? null
      return next
    })
    return { runNodes }
  }),
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

  setActiveTab: (tab) => {
    persistActiveTab(tab)
    set({ activeTab: tab })
  },
  setStreamStatus: (streamStatus) => set({ streamStatus }),
  setStreamTransport: (streamTransport) => set({ streamTransport }),
  resetRun: () => set({ runId: null, runNodes: [], events: [], eventsCursor: null, eventsHasMore: false, streamStatus: 'idle', streamTransport: 'idle' }),
  addToast: (message, tone = 'info') => {
    const id = crypto.randomUUID()
    set((state) => ({ toasts: [...state.toasts, { id, message, tone }] }))
    // Errors need longer on screen than success/info: an error often asks the
    // reader to act (switch panel, fix a field) before it auto-dismisses.
    setTimeout(() => get().removeToast(id), tone === 'error' ? TOAST_TTL_ERROR_MS : TOAST_TTL_DEFAULT_MS)
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
  setOnboarding: (onboarding) => set({ onboarding }),
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

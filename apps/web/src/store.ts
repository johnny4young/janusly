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
import type { ActiveTab, JsonObject, RunEvent, RunNode, RunSummary, WorkflowDefinition, WorkflowGraphEdge, WorkflowGraphNode } from './types'
import type { OnboardingState } from '@janusly/shared/src/onboarding'
import type { SessionContext } from './identity-context'
import { getNodePreset } from './constants'
import { t } from './i18n/runtime'
import { workflowToGraph } from './canvas-projections'

/**
 * Build the config for an explicit step-kind change.
 *
 * The transition starts from the localized target preset, keeps only valid
 * runtime-wide retry/timeout controls, and drops source-kind fields. MCP calls
 * cap timeout at 120 seconds, so a larger source value cannot cross the seam.
 */
function getNodeTypeChangeConfig(type: string, previous: JsonObject): JsonObject {
  const next = getNodePreset(type)
  const retry = sanitizeRetryPolicy(previous.retry)
  if (retry) next.retry = retry

  const timeoutMs = previous.timeoutMs
  if (
    typeof timeoutMs === 'number'
    && Number.isFinite(timeoutMs)
    && Number.isInteger(timeoutMs)
    && timeoutMs > 0
    && (type !== 'mcp_tool' || timeoutMs <= 120_000)
  ) next.timeoutMs = timeoutMs

  return next
}

/** Copy only the closed, runtime-supported subset of a serialized retry policy. */
function sanitizeRetryPolicy(value: unknown): JsonObject | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const retry: JsonObject = {}

  if (typeof source.maxAttempts === 'number' && Number.isInteger(source.maxAttempts) && source.maxAttempts > 0) {
    retry.maxAttempts = source.maxAttempts
  }
  for (const key of ['delayMs', 'maxDelayMs'] as const) {
    const candidate = source[key]
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0) retry[key] = candidate
  }
  if (source.backoff === 'fixed' || source.backoff === 'exponential') retry.backoff = source.backoff
  if (typeof source.jitter === 'boolean') retry.jitter = source.jitter
  for (const key of ['retryOn', 'ignoreOn'] as const) {
    const candidate = source[key]
    if (Array.isArray(candidate) && candidate.every((entry) => typeof entry === 'string')) retry[key] = [...candidate]
  }

  return Object.keys(retry).length > 0 ? retry : null
}

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
type FlowOps = {
  applyNodeChanges: (
    changes: Parameters<OnNodesChange<WorkflowGraphNode>>[0],
    nodes: WorkflowGraphNode[],
  ) => WorkflowGraphNode[]
  applyEdgeChanges: (
    changes: Parameters<OnEdgesChange<WorkflowGraphEdge>>[0],
    edges: WorkflowGraphEdge[],
  ) => WorkflowGraphEdge[]
  addEdge: (edge: Connection | WorkflowGraphEdge, edges: WorkflowGraphEdge[]) => WorkflowGraphEdge[]
}
let flowOps: FlowOps | null = null
export function registerFlowOps(ops: FlowOps): void {
  flowOps = ops
}

type NodePlacementResolver = () => { x: number; y: number } | null
let nodePlacementResolver: NodePlacementResolver | null = null

/** Register a lazy-canvas placement resolver without importing React Flow here. */
export function registerNodePlacementResolver(resolver: NodePlacementResolver): () => void {
  nodePlacementResolver = resolver
  return () => {
    if (nodePlacementResolver === resolver) nodePlacementResolver = null
  }
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
  identityContext: SessionContext | null
  identityReady: boolean

  currentWorkflowId: string
  currentWorkflowName: string
  /**
   * Whether the current workflow exists server-side. False for the initial
   * blank draft and after `newWorkflow()`; true once loaded from the server
   * or successfully saved. Health/metadata lookups skip unsaved drafts so a
   * never-saved workflow doesn't 404 the health/metadata endpoints on load.
   */
  currentWorkflowSaved: boolean
  /**
   * Whether the canvas holds semantic edits not yet persisted as a workflow
   * version. False for the untouched blank draft and after hydrate/new/save;
   * true after any persisted node/edge/config/name/layout mutation. Drives the unsaved-work guards
   * (confirm-before-replace, beforeunload) and the local draft autosave.
   */
  workflowDirty: boolean
  /** Monotonic semantic-workflow revision. Canvas position/selection changes
   * never increment it; authoring checks use it to invalidate stale findings. */
  workflowRevision: number
  /** Declared input shape — surfaced in the Inspector + validated at run start. */
  currentWorkflowInputs: WorkflowDefinition['inputs']
  /** Declared output projection map — engine renders templates at terminal status. */
  currentWorkflowOutputs: WorkflowDefinition['outputs']
  /** Opt-in strict handling for unresolved node-config templates. */
  currentWorkflowTemplatePolicy: WorkflowDefinition['templatePolicy']
  nodes: WorkflowGraphNode[]
  edges: WorkflowGraphEdge[]
  selectedNodeId: string | null
  selectedEdgeId: string | null

  runId: string | null
  /** Monotonic ownership generation for async run requests. Any identity,
   *  workflow, or active-run transition increments it atomically with the
   *  associated reset so late responses can fail closed. */
  runTransitionGeneration: number
  /** Full detail for the selected run. Unlike `/runs`, this preserves the
   *  immutable input snapshot used by the observation canvas. */
  runDetail: RunSummary | null
  runNodes: RunNode[]
  events: RunEvent[]
  eventsCursor: string | null
  eventsHasMore: boolean
  activeTab: ActiveTab
  /** Contextual Recovery Case selection. Cleared on identity changes and not persisted across reloads. */
  activeRecoveryCaseId: string | null
  streamStatus: StreamStatus
  streamTransport: StreamTransport
  toasts: Toast[]
  platformVersion: number
  /** Most recent HTTP 402 budget-block envelope from any /ai/* route. The
   *  AI Studio top-of-canvas BudgetBlockedBanner reads this slot; the
   *  api() wrapper sets it on every 402; clearBudgetBlocked() unsets. */
  budgetBlocked: BudgetBlockedEnvelope | null
  /** Latest "first recovered run" onboarding snapshot. The contextual
   *  OnboardingBanner self-fetches `/onboarding` on mount + every platformVersion bump
   *  and stores the result here; renders only while `status === 'active'`. */
  onboarding: OnboardingState | null
  /** Session-only Recovery Center walkthrough dismissal. Fresh workspaces do
   *  not persist this preference until they have real terminal history. */
  recoveryIntroDismissedThisSession: boolean

  setAuth: (payload: { session: Session | null; user: User | null; userId: string | null; orgId: string | null }) => void
  clearAuth: () => void
  setAuthReady: (ready: boolean) => void
  setIdentityContext: (context: SessionContext | null) => void
  setIdentityPending: () => void
  dismissRecoveryIntroThisSession: () => void

  addNode: (type: string, position?: { x: number; y: number }) => void
  duplicateNode: (nodeId: string) => void
  hydrateWorkflow: (workflow: WorkflowDefinition, options?: { saved?: boolean; dirty?: boolean }) => void
  /** Set the localized starter name once React mounts after i18n bootstrap. */
  initializeWorkflowName: (name: string) => void
  getWorkflowJson: () => WorkflowDefinition
  newWorkflow: () => void
  /** Mark the current workflow as persisted server-side (after a successful save). */
  markWorkflowSaved: () => void
  /** Force the dirty flag on — used after restoring a local draft (the restored content isn't server-side). */
  markWorkflowDirty: () => void
  setWorkflowName: (name: string) => void
  setNodes: (nodes: WorkflowGraphNode[]) => void
  setEdges: (edges: WorkflowGraphEdge[]) => void
  onNodesChange: OnNodesChange<WorkflowGraphNode>
  onEdgesChange: OnEdgesChange<WorkflowGraphEdge>
  connect: (connection: Connection) => void
  selectNode: (id: string | null) => void
  selectEdge: (id: string | null) => void
  updateSelectedNodeConfig: (config: JsonObject) => void
  updateSelectedNodeType: (type: string) => void
  updateNodeLabel: (nodeId: string, label: string) => void
  updateWorkflowInputs: (inputs: WorkflowDefinition['inputs']) => void
  updateWorkflowOutputs: (outputs: WorkflowDefinition['outputs']) => void
  updateWorkflowTemplatePolicy: (policy: WorkflowDefinition['templatePolicy']) => void
  updateEdgeCondition: (id: string, condition: string | null) => void

  setRunId: (id: string | null) => void
  setRunDetail: (run: RunSummary | null) => void
  patchRunDetail: (runId: string, patch: Partial<RunSummary>) => void
  setRunNodes: (nodes: RunNode[]) => void
  mergeRunNode: (node: RunNode) => void
  addEvents: (events: RunEvent[]) => void
  setEvents: (events: RunEvent[]) => void
  setEventsPagination: (cursor: string | null, hasMore: boolean) => void
  setActiveTab: (tab: ActiveTab) => void
  openRecoveryCase: (caseId: string) => void
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
  'home', 'recover', 'workflows', 'members', 'copilot', 'marketplace', 'templates',
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

const initialWorkflowId = `workflow_${crypto.randomUUID().slice(0, 8)}`

function clearedRunProjection(runTransitionGeneration: number) {
  return {
    runId: null,
    runTransitionGeneration: runTransitionGeneration + 1,
    runDetail: null,
    runNodes: [],
    events: [],
    eventsCursor: null,
    eventsHasMore: false,
    streamStatus: 'idle' as const,
    streamTransport: 'idle' as const,
  }
}

function graphToWorkflow(
  id: string,
  name: string,
  nodes: WorkflowGraphNode[],
  edges: WorkflowGraphEdge[],
  inputs: WorkflowDefinition['inputs'],
  outputs: WorkflowDefinition['outputs'],
  templatePolicy: WorkflowDefinition['templatePolicy'],
): WorkflowDefinition {
  return {
    id,
    name,
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.data.type,
      ...(node.data.label.trim() ? { label: node.data.label.trim() } : {}),
      config: node.data.config ?? {},
    })),
    edges: edges.map((edge) => ({
      from: edge.source,
      to: edge.target,
      condition: edge.data?.condition || undefined,
    })),
    ...(inputs ? { inputs } : {}),
    ...(outputs ? { outputs } : {}),
    ...(templatePolicy ? { templatePolicy } : {}),
    ui: {
      positions: Object.fromEntries(nodes
        .filter(node => Number.isFinite(node.position.x) && Number.isFinite(node.position.y))
        .map(node => [node.id, { x: node.position.x, y: node.position.y }])),
    },
  }
}

export const useWorkflowStore = create<WorkflowStore>((set, get) => ({
  session: null,
  user: null,
  userId: null,
  orgId: null,
  authReady: false,
  identityContext: null,
  identityReady: false,

  currentWorkflowId: initialWorkflowId,
  // `main.tsx` starts downloading App in parallel with the locale catalog, so
  // module evaluation can precede i18next initialization. App fills this
  // sentinel before paint; never translate during store module evaluation.
  currentWorkflowName: '',
  currentWorkflowSaved: false,
  workflowDirty: false,
  workflowRevision: 0,
  currentWorkflowInputs: undefined,
  currentWorkflowOutputs: undefined,
  currentWorkflowTemplatePolicy: undefined,
  nodes: [],
  edges: [],
  selectedNodeId: null,
  selectedEdgeId: null,
  runId: null,
  runTransitionGeneration: 0,
  runDetail: null,
  runNodes: [],
  events: [],
  eventsCursor: null,
  eventsHasMore: false,
  // The Recovery Center is the authenticated landing page (the operator's most
  // frequent job is triaging failed runs / pending approvals / cluster
  // recovery). When the operator has navigated elsewhere, the last tab is
  // restored from localStorage so a refresh doesn't drop them back to Home.
  activeTab: readStoredActiveTab(),
  activeRecoveryCaseId: null,
  streamStatus: 'idle',
  streamTransport: 'idle',
  toasts: [],
  platformVersion: 0,
  budgetBlocked: null,
  onboarding: null,
  recoveryIntroDismissedThisSession: false,

  setAuth: ({ session, user, userId, orgId }) => set((state) => ({
    session,
    user,
    userId,
    orgId,
    authReady: true,
    ...(state.userId !== userId || state.orgId !== orgId
      ? {
          identityContext: null,
          identityReady: false,
          toasts: [],
          activeRecoveryCaseId: null,
          activeTab: state.activeTab === 'recoveryCase' ? 'home' : state.activeTab,
          ...clearedRunProjection(state.runTransitionGeneration),
          recoveryIntroDismissedThisSession: false,
        }
      : {}),
  })),
  clearAuth: () => set((state) => ({
    session: null,
    user: null,
    userId: null,
    orgId: null,
    authReady: true,
    identityContext: null,
    identityReady: true,
    // Notifications belong to the departing identity/workspace. Keeping them
    // after logout can disclose stale operational details to the next user.
    toasts: [],
    activeRecoveryCaseId: null,
    activeTab: state.activeTab === 'recoveryCase' ? 'home' : state.activeTab,
    recoveryIntroDismissedThisSession: false,
    ...clearedRunProjection(state.runTransitionGeneration),
  })),
  setAuthReady: (authReady) => set({ authReady }),
  setIdentityContext: (identityContext) => set({ identityContext, identityReady: true }),
  setIdentityPending: () => set({ identityReady: false }),
  dismissRecoveryIntroThisSession: () => set({ recoveryIntroDismissedThisSession: true }),

  addNode: (type, position) => {
    const id = crypto.randomUUID().slice(0, 8)
    set((state) => ({
      workflowDirty: true,
      workflowRevision: state.workflowRevision + 1,
      nodes: state.nodes.concat({
        id,
        position: position ?? nodePlacementResolver?.() ?? { x: 120 + state.nodes.length * 80, y: 120 + state.nodes.length * 40 },
        // Leave `data.label` empty so the canvas component resolves the
        // human label via `getNodeLabel(type)` at render time.
        data: { label: '', type, config: getNodePreset(type) },
      })
    }))
  },

  duplicateNode: (nodeId) => {
    const id = crypto.randomUUID().slice(0, 8)
    set((state) => {
      const source = state.nodes.find((node) => node.id === nodeId)
      if (!source) return state
      return {
        workflowDirty: true,
        workflowRevision: state.workflowRevision + 1,
        selectedNodeId: id,
        selectedEdgeId: null,
        nodes: state.nodes.concat({
          id,
          type: source.type,
          position: { x: source.position.x + 32, y: source.position.y + 32 },
          data: {
            ...source.data,
            config: structuredClone(source.data.config),
          },
        }),
      }
    })
  },

  hydrateWorkflow: (workflow, options) => {
    const saved = options?.saved ?? true
    const dirty = options?.dirty ?? false
    const graph = workflowToGraph(workflow)
    set((state) => ({
      currentWorkflowId: workflow.id ?? 'ui-test',
      currentWorkflowName: workflow.name ?? workflow.id ?? (t('workflow.defaultName')),
      currentWorkflowSaved: saved,
      workflowDirty: dirty,
      currentWorkflowInputs: workflow.inputs,
      currentWorkflowOutputs: workflow.outputs,
      currentWorkflowTemplatePolicy: workflow.templatePolicy,
      nodes: graph.nodes,
      edges: graph.edges,
      selectedNodeId: null,
      selectedEdgeId: null,
      ...clearedRunProjection(state.runTransitionGeneration),
      workflowRevision: state.workflowRevision + 1,
    }))
  },

  initializeWorkflowName: (name) => set((state) => (
    state.currentWorkflowName.length === 0 ? { currentWorkflowName: name } : state
  )),

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
      state.currentWorkflowTemplatePolicy,
    )
  },

  newWorkflow: () => {
    const id = `workflow_${crypto.randomUUID().slice(0, 8)}`
    set((state) => ({
      currentWorkflowId: id,
      currentWorkflowName: t('workflow.defaultName'),
      currentWorkflowSaved: false,
      workflowDirty: false,
      currentWorkflowInputs: undefined,
      currentWorkflowOutputs: undefined,
      currentWorkflowTemplatePolicy: undefined,
      nodes: [],
      edges: [],
      selectedNodeId: null,
      selectedEdgeId: null,
      ...clearedRunProjection(state.runTransitionGeneration),
      activeTab: 'copilot',
      workflowRevision: state.workflowRevision + 1,
    }))
  },

  setWorkflowName: (currentWorkflowName) => set((state) => ({ currentWorkflowName, workflowDirty: true, workflowRevision: state.workflowRevision + 1 })),
  setNodes: (nodes) => set((state) => ({ nodes, workflowDirty: true, workflowRevision: state.workflowRevision + 1 })),
  setEdges: (edges) => set((state) => ({ edges, workflowDirty: true, workflowRevision: state.workflowRevision + 1 })),
  // A completed position change is persisted and marks the draft dirty, but it
  // does not invalidate semantic readiness/AI findings. Removal does both.
  onNodesChange: (changes) => set((state) => (flowOps
    ? {
        nodes: flowOps.applyNodeChanges(changes, state.nodes),
        ...(changes.some((c) => c.type === 'remove')
          ? { workflowDirty: true, workflowRevision: state.workflowRevision + 1 }
          : changes.some((c) => c.type === 'position' && c.dragging !== true)
            ? { workflowDirty: true }
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
    set((state) => {
      const selectedNode = state.nodes.find((node) => node.id === selectedNodeId)
      if (!selectedNode || selectedNode.data.type === type) return state
      return {
        workflowDirty: true,
        workflowRevision: state.workflowRevision + 1,
        nodes: state.nodes.map((node) => node.id === selectedNodeId
          ? { ...node, data: { ...node.data, type, config: getNodeTypeChangeConfig(type, node.data.config) } }
          : node),
      }
    })
  },

  updateNodeLabel: (nodeId, label) => {
    set((state) => {
      const targetNode = state.nodes.find(node => node.id === nodeId)
      if (!targetNode || targetNode.data.label === label) return state
      return {
        workflowDirty: true,
        workflowRevision: state.workflowRevision + 1,
        nodes: state.nodes.map(node => node.id === nodeId
          ? { ...node, data: { ...node.data, label } }
          : node),
      }
    })
  },

  updateWorkflowInputs: (currentWorkflowInputs) => set((state) => ({
    currentWorkflowInputs,
    workflowDirty: true,
    workflowRevision: state.workflowRevision + 1,
  })),

  updateWorkflowOutputs: (currentWorkflowOutputs) => set((state) => ({
    currentWorkflowOutputs,
    workflowDirty: true,
    workflowRevision: state.workflowRevision + 1,
  })),

  updateWorkflowTemplatePolicy: (currentWorkflowTemplatePolicy) => set((state) => ({
    currentWorkflowTemplatePolicy,
    workflowDirty: true,
    workflowRevision: state.workflowRevision + 1,
  })),

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

  setRunId: (id) => set((state) => state.runId === id
    ? { runId: id }
    : { ...clearedRunProjection(state.runTransitionGeneration), runId: id }),
  setRunDetail: (runDetail) => set({ runDetail }),
  patchRunDetail: (runId, patch) => set((state) => (
    state.runId === runId && state.runDetail?.id === runId
      ? { runDetail: { ...state.runDetail, ...patch, id: runId } }
      : state
  )),
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
  openRecoveryCase: (caseId) => {
    set({ activeRecoveryCaseId: caseId, activeTab: 'recoveryCase' })
  },
  setStreamStatus: (streamStatus) => set({ streamStatus }),
  setStreamTransport: (streamTransport) => set({ streamTransport }),
  resetRun: () => set((state) => clearedRunProjection(state.runTransitionGeneration)),
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

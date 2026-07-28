/**
 * `App` — top-level Janusly Studio shell.
 *
 * Owns the React Flow canvas, the sidebar nav, the right-side inspector
 * panel, and all of the API call sites for workflows, runs, members, AI,
 * credentials, and plugins. Runs polling against `/status` while a run is
 * active and tears it down on terminal state.
 *
 * Used by `apps/web/src/main.tsx` — single entry point, single instance.
 *
 * Invariants:
 * - Polling at 1500ms calls `loadStatus(runId)` and merges events via the
 *   Zustand store (`mergeEvents`) — DON'T replace events wholesale or you
 *   re-introduce the timeline-clobber bug.
 * - Terminal-state branch fires `bumpPlatformVersion()` so independent
 *   panels re-fetch (cross-panel reactivity invariant).
 * - Web deps lockdown: only the AGENTS-approved imports plus
 *   `@janusly/shared/src/status` for zero-dep lifecycle guards. Don't add
 *   radix/cva/clsx/tailwind-merge here.
 */

import React, { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Layout } from './Layout'
import { BrandMark } from './components/BrandMark'
import { BuilderSidebar } from './components/BuilderSidebar'
// On-demand overlays — code-split so their JS loads on first open (each is
// gated on its open flag in the overlay below), not in the eager App chunk.
const CommandPalette = lazy(() => import('./components/CommandPalette').then((m) => ({ default: m.CommandPalette })))
const SnippetInsertMenu = lazy(() => import('./components/SnippetInsertMenu').then((m) => ({ default: m.SnippetInsertMenu })))
const ShortcutsModal = lazy(() => import('./components/ShortcutsModal').then((m) => ({ default: m.ShortcutsModal })))
// The editor canvas (React Flow) is code-split so `@xyflow/react` — the
// heaviest web dependency — loads on first navigation to a canvas-bearing
// tab, not at boot. `CanvasWorkspace` owns the `<ReactFlowProvider>`.
const CanvasWorkspace = lazy(() => import('./components/CanvasWorkspace').then((m) => ({ default: m.CanvasWorkspace })))
const RunObservationWorkspace = lazy(() => import('./components/CanvasWorkspace').then((m) => ({ default: m.RunObservationWorkspace })))
const RecoveryCenterPanel = lazy(() => import('./components/RecoveryCenterPanel').then((m) => ({ default: m.RecoveryCenterPanel })))
import { RightPanel } from './components/RightPanel'
import { ErrorBoundary } from './components/ErrorBoundary'
import { PanelErrorFallback } from './components/PanelErrorFallback'
import { BudgetBlockedBanner } from './components/BudgetBlockedBanner'
import { Login } from './components/Login'
import { WorkspaceGate } from './components/WorkspaceGate'
import { UserMenu } from './components/UserMenu'
import { WorkflowReadinessBadge } from './components/WorkflowReadinessBadge'
import { WorkflowHealthBadge } from './components/WorkflowHealthBadge'
const RunInputDialog = lazy(() => import('./components/RunInputDialog').then((m) => ({ default: m.RunInputDialog })))
import { Activity, ChevronRight, PlayCircle, Search, ShieldAlert, ShieldCheck } from 'lucide-react'
import { AuthProvider, isSupabaseConfigured } from './auth'
import { useWorkflowStore } from './store'
import { useShallow } from 'zustand/react/shallow'
import { api } from './api'
import { useRunEventStream } from './hooks/useRunEventStream'
import { patchRunSummaryList, useBootstrapData } from './hooks/useBootstrapData'
import { useRunPolling } from './hooks/useRunPolling'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { usePlatformMutation } from './hooks/usePlatformMutation'
import { useDraftAutosave, readDraft, readLatestDraft, clearDraft } from './hooks/useDraftPersistence'
import { useConfirm } from './components/ConfirmDialog'
import { formatStatusLabel } from './constants'
import { projectVisibleEdges, projectVisibleNodes } from './canvas-projections'
import type { ActiveTab, AiMode, AiReviewIssue, ReadinessResult, RunEvent, RunNode, RunSummary, ValidationIssue, WorkflowDefinition, WorkflowGraphEdge, WorkflowGraphNode } from './types'
import { getCanvasVisibility, isCanvasTab, parseAiCandidateBackoff } from './types'
import { isTerminalRunStatus } from '@janusly/shared/src/status'
import { getResolvedLocale, useT } from './i18n'
import { consumeDeadLetterDeepLink, requestRecoveryQueueFocus } from './components/recovery-queue-focus-bus'
import { requestRecoveryAllClearIfQueueEmpty } from './components/recovery-all-clear-coordinator'
import { countActiveRecoveryBlockers } from './components/recovery-center/recovery-center-model'
import { DOCS_URL } from './docs-link'
import { createRunTransitionGuard, isRunRequestCurrent } from './run-transition'
import type { SessionContext } from './identity-context'
import { currentSessionOrganization } from './identity-context'
import { canOpenTab, firstOpenTab } from './tab-permissions'
import {
  resolveWorkspaceDestinationTarget,
  type WorkspaceDestination,
} from './workspace-locations'

type RunResponse = {
  run?: RunSummary
  nodes?: RunNode[]
  events?: RunEvent[]
  eventsCursor?: string | null
  eventsHasMore?: boolean
}

const CANVAS_PALETTE_TYPES: string[] = ['http', 'ai', 'condition', 'tool', 'agent']
const EMPTY_PERMISSIONS: readonly string[] = Object.freeze([])

type ValidationResponse = {
  valid: boolean
  issues?: ValidationIssue[]
}

type GenerateWorkflowResponse = WorkflowDefinition & {
  mode?: AiMode
  error?: string
  aiError?: string
  bonBackoff?: unknown
}

type ExplainWorkflowResponse = {
  mode?: AiMode
  explanation?: string
  model?: string
  error?: string
  aiError?: string
}

type ReviewWorkflowResponse = {
  mode?: AiMode
  model?: string
  review?: {
    status: 'pass' | 'warn' | 'fail'
    issues: AiReviewIssue[]
  }
  error?: string
  aiError?: string
}

export default function App() {
  const {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    connect,
    addNode,
    activeTab,
    activeRecoveryCaseId,
    userId,
    orgId,
    authReady,
    identityContext,
    identityReady,
    runId,
    runDetail,
    runNodes,
    events,
    selectedNodeId,
    selectedEdgeId,
    currentWorkflowId,
    currentWorkflowName,
    currentWorkflowSaved,
    currentWorkflowInputs,
    currentWorkflowOutputs,
    workflowRevision,
    streamStatus,
    setAuth,
    clearAuth,
    setAuthReady,
    setIdentityContext,
    setIdentityPending,
    setActiveTab,
    openRecoveryCase,
    setWorkflowName,
    initializeWorkflowName,
    hydrateWorkflow,
    getWorkflowJson,
    newWorkflow,
    markWorkflowSaved,
    selectNode,
    selectEdge,
    updateSelectedNodeConfig,
    updateSelectedNodeType,
    setRunId,
    setRunDetail,
    patchRunDetail,
    setRunNodes,
    setEvents,
    addEvents,
    eventsCursor,
    eventsHasMore,
    setEventsPagination,
    addToast,
    updateEdgeCondition: storeUpdateEdgeCondition,
    bumpPlatformVersion,
    // Scoped selector (was a selector-less `useWorkflowStore()` that
    // re-rendered the root on EVERY store mutation). With useShallow the App
    // root only re-renders when one of the fields it actually reads changes —
    // unrelated ticks (e.g. platformVersion bumps) no longer re-render it.
  } = useWorkflowStore(useShallow((s) => ({
    nodes: s.nodes,
    edges: s.edges,
    onNodesChange: s.onNodesChange,
    onEdgesChange: s.onEdgesChange,
    connect: s.connect,
    addNode: s.addNode,
    activeTab: s.activeTab,
    activeRecoveryCaseId: s.activeRecoveryCaseId,
    session: s.session,
    userId: s.userId,
    orgId: s.orgId,
    authReady: s.authReady,
    identityContext: s.identityContext,
    identityReady: s.identityReady,
    runId: s.runId,
    runDetail: s.runDetail,
    runNodes: s.runNodes,
    events: s.events,
    selectedNodeId: s.selectedNodeId,
    selectedEdgeId: s.selectedEdgeId,
    currentWorkflowId: s.currentWorkflowId,
    currentWorkflowName: s.currentWorkflowName,
    currentWorkflowSaved: s.currentWorkflowSaved,
    currentWorkflowInputs: s.currentWorkflowInputs,
    currentWorkflowOutputs: s.currentWorkflowOutputs,
    workflowRevision: s.workflowRevision,
    streamStatus: s.streamStatus,
    setAuth: s.setAuth,
    clearAuth: s.clearAuth,
    setAuthReady: s.setAuthReady,
    setIdentityContext: s.setIdentityContext,
    setIdentityPending: s.setIdentityPending,
    setActiveTab: s.setActiveTab,
    openRecoveryCase: s.openRecoveryCase,
    setWorkflowName: s.setWorkflowName,
    initializeWorkflowName: s.initializeWorkflowName,
    hydrateWorkflow: s.hydrateWorkflow,
    getWorkflowJson: s.getWorkflowJson,
    newWorkflow: s.newWorkflow,
    markWorkflowSaved: s.markWorkflowSaved,
    selectNode: s.selectNode,
    selectEdge: s.selectEdge,
    updateSelectedNodeConfig: s.updateSelectedNodeConfig,
    updateSelectedNodeType: s.updateSelectedNodeType,
    setRunId: s.setRunId,
    setRunDetail: s.setRunDetail,
    patchRunDetail: s.patchRunDetail,
    setRunNodes: s.setRunNodes,
    setEvents: s.setEvents,
    addEvents: s.addEvents,
    eventsCursor: s.eventsCursor,
    eventsHasMore: s.eventsHasMore,
    setEventsPagination: s.setEventsPagination,
    addToast: s.addToast,
    updateEdgeCondition: s.updateEdgeCondition,
    bumpPlatformVersion: s.bumpPlatformVersion,
  })))

  const { t } = useT()

  useLayoutEffect(() => {
    initializeWorkflowName(t('workflow.defaultName'))
  }, [initializeWorkflowName, t])

  const [validationIssues, setValidationIssues] = useState<ValidationIssue[]>([])
  const [readinessResult, setReadinessResult] = useState<ReadinessResult | null>(null)
  const [aiReviewIssues, setAiReviewIssues] = useState<AiReviewIssue[]>([])
  const [currentWorkflowVersion, setCurrentWorkflowVersion] = useState<number | null>(null)
  const handleReadinessResult = useCallback((result: ReadinessResult | null) => {
    setReadinessResult(result)
  }, [])

  // Findings describe one exact serialized graph. Any semantic mutation makes
  // validation/AI review stale immediately; readiness publishes a fresh,
  // debounced result through the header badge. Canvas drags do not increment
  // this revision and therefore preserve the diagnostics.
  useEffect(() => {
    setValidationIssues([])
    setAiReviewIssues([])
    setReadinessResult(null)
  }, [workflowRevision])
  // Server-data bootstrap (tools / templates / packs / credentials / runs /
  // saved workflows / dead letters / usage / ai-health) + the `refreshPlatform`
  // fan-out, fired once `authReady` flips.
  const tenantReady = authReady && identityReady && Boolean(identityContext?.currentOrganizationId)
  const currentOrganization = useMemo(
    () => currentSessionOrganization(identityContext),
    [identityContext],
  )
  const tenantPermissions = currentOrganization?.permissions ?? EMPTY_PERMISSIONS
  const canWriteWorkflows = tenantPermissions.includes('workflows.write')
  const canStartRuns = tenantPermissions.includes('runs.start')
  const canReadRuns = tenantPermissions.includes('runs.read')
  const canReadRecovery = tenantPermissions.includes('recovery.read')
  const canReadDlq = tenantPermissions.includes('dlq.read')
  const canInstallPacks = tenantPermissions.includes('packs.install')
  const {
    tools,
    templates,
    solutionPacks,
    credentials,
    runs,
    savedWorkflows,
    deadLetters,
    usage,
    aiHealth,
    refreshPlatform,
    patchRunSummary,
    beginRunSummaryUpdate,
  } = useBootstrapData(
    tenantReady ? identityContext?.currentOrganizationId ?? null : null,
    tenantPermissions,
  )

  const projectRunSummary = useCallback((id: string, patch: Partial<RunSummary>) => {
    patchRunSummary(id, patch)
    patchRunDetail(id, patch)
  }, [patchRunDetail, patchRunSummary])

  const beginRunProjectionUpdate = useCallback((id: string) => {
    const commitSummary = beginRunSummaryUpdate(id)
    return (patch: Partial<RunSummary>) => {
      if (!commitSummary(patch)) return false
      patchRunDetail(id, patch)
      return true
    }
  }, [beginRunSummaryUpdate, patchRunDetail])

  // The selected detail is the freshest complete snapshot for its run. Fold it
  // into list consumers so a slower collection refresh cannot make the active
  // card and history row disagree with the observation canvas.
  const projectedRuns = useMemo(
    () => runId && runDetail?.id === runId
      ? patchRunSummaryList(runs, runId, runDetail)
      : runs,
    [runDetail, runId, runs],
  )

  useEffect(() => {
    if (!tenantReady || canOpenTab(activeTab, tenantPermissions)) return
    const fallback = firstOpenTab(tenantPermissions)
    if (fallback) setActiveTab(fallback)
  }, [activeTab, setActiveTab, tenantPermissions, tenantReady])
  // Run-input dialog state. Open when the active workflow declares typed
  // `inputs` and the user presses Run; closed otherwise. Server errors
  // (JSONPath strings) are stored separately so the dialog can surface
  // them next to the right field without losing them in a toast.
  const [runInputOpen, setRunInputOpen] = useState(false)
  const [runInputServerErrors, setRunInputServerErrors] = useState<string[]>([])
  const [runInputSubmitting, setRunInputSubmitting] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [semanticBlockerRunIds, setSemanticBlockerRunIds] = useState<string[]>([])
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [snippetMenuOpen, setSnippetMenuOpen] = useState(false)
  // React Flow cannot establish a valid viewport when its first mount happens
  // under display:none (for example, after reloading on Runs). Defer that first
  // mount until a canvas tab is visible, then retain the instance across other
  // non-home tabs so operator pan/zoom still survives ordinary navigation.
  const [canvasActivated, setCanvasActivated] = useState(() => isCanvasTab(activeTab))

  useEffect(() => {
    setSemanticBlockerRunIds([])
  }, [orgId])
  useEffect(() => {
    if (activeTab === 'home') {
      setCanvasActivated(false)
    } else if (isCanvasTab(activeTab)) {
      setCanvasActivated(true)
    }
  }, [activeTab])
  // Stable references for the overlay close callbacks. Inline arrows here
  // would create a fresh function ref on every App render — polling at 1.5s
  // plus every Zustand mutation would re-bind the Escape keydown listener
  // inside each modal's `useEffect`. useCallback pins the ref.
  const closePalette = useCallback(() => setPaletteOpen(false), [])
  const closeShortcuts = useCallback(() => setShortcutsOpen(false), [])
  const openShortcuts = useCallback(() => setShortcutsOpen(true), [])
  const closeSnippetMenu = useCallback(() => setSnippetMenuOpen(false), [])

  // Stable canvas handlers + palette list so React.memo(WorkflowCanvas) holds
  // and the (expensive) canvas subtree stops re-rendering on unrelated store
  // ticks. selectNode/selectEdge/setActiveTab are stable Zustand actions.
  const handleNodeClick = useCallback((_: React.MouseEvent, node: WorkflowGraphNode) => {
    selectNode(node.id)
    setActiveTab('inspector')
  }, [selectNode, setActiveTab])
  const handleEdgeClick = useCallback((_: React.MouseEvent, edge: WorkflowGraphEdge) => {
    selectEdge(edge.id)
    setActiveTab('inspector')
  }, [selectEdge, setActiveTab])
  const canvasPaletteTypes = isCanvasTab(activeTab) ? CANVAS_PALETTE_TYPES : undefined

  // One sign-out driver for keyboard and Command Palette entry points:
  // AuthProvider.signOut → clearAuth → toast.
  const signOut = useCallback(async () => {
    try {
      await AuthProvider.signOut()
      clearAuth()
      addToast(t('toasts.signedOut'), 'info')
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('toasts.signOutFailed'), 'error')
    }
  }, [addToast, clearAuth, t])

  // Global keyboard shortcuts:
  //   Cmd/Ctrl+K — toggle command palette
  //   ?         — open keyboard shortcuts overlay (when not typing in an input)
  //   /         — focus the sidebar search (when not typing in an input)
  //   Ctrl+Shift+Q — sign out (matches the kbd shown in the user menu)
  const togglePalette = useCallback(() => setPaletteOpen(prev => !prev), [])
  const toggleShortcuts = useCallback(() => setShortcutsOpen(prev => !prev), [])
  const focusSidebarSearch = useCallback(() => {
    // Focus the sidebar search input via a stable data attribute so a
    // future CSS class rename doesn't silently no-op the shortcut.
    const search = document.querySelector<HTMLInputElement>('[data-shortcut="sidebar-search"]')
    if (search) {
      search.focus()
      search.select()
      return true
    }
    return false
  }, [])
  const fireSignOut = useCallback(() => { void signOut() }, [signOut])
  const openWorkspaceDestination = useCallback((destination: WorkspaceDestination) => {
    const target = resolveWorkspaceDestinationTarget(destination, tenantPermissions)
    if (target) setActiveTab(target)
  }, [setActiveTab, tenantPermissions])
  // NOTE: `useKeyboardShortcuts` is mounted further down, after `saveWorkflow`
  // exists (Cmd/Ctrl+S needs it and const hoisting doesn't apply).

  const confirm = useConfirm()

  /**
   * Unsaved-work guard: every path that replaces the canvas asks first
   * when the canvas holds edits not yet saved as a version. Resolves true when
   * it's safe to proceed (clean canvas, or the author confirmed the discard).
   * The local draft autosave has already captured the outgoing content, so
   * "discard" here never actually loses the work.
   */
  const confirmReplaceCanvas = useCallback(async (): Promise<boolean> => {
    if (!useWorkflowStore.getState().workflowDirty) return true
    return confirm({
      title: t('unsavedGuard.title'),
      body: t('unsavedGuard.body'),
      confirmLabel: t('unsavedGuard.discard'),
      tone: 'danger',
    })
  }, [confirm, t])

  const createNewWorkflow = useCallback(async (targetTab?: ActiveTab): Promise<void> => {
    if (!await confirmReplaceCanvas()) return
    newWorkflow()
    setValidationIssues([])
    setCurrentWorkflowVersion(null)
    if (targetTab) setActiveTab(targetTab)
  }, [confirmReplaceCanvas, newWorkflow, setActiveTab])

  // Warn on tab close / reload while the canvas holds unsaved edits. The
  // browser shows its own generic dialog; we only flag the condition.
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (!useWorkflowStore.getState().workflowDirty) return
      event.preventDefault()
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  // Debounced localStorage autosave of unsaved canvas edits (drafts).
  useDraftAutosave()

  /**
   * Offer to restore a local draft for `workflowId` (newer, unsaved canvas
   * content captured by the autosave). Declining discards the draft so the
   * author isn't re-prompted forever.
   */
  const maybeRestoreDraft = useCallback(async (workflowId: string, savedBase = false): Promise<void> => {
    const draft = readDraft(workflowId)
    if (!draft) return
    const restore = await confirm({
      title: t('draftRestore.title'),
      body: t('draftRestore.body', { time: new Date(draft.savedAt).toLocaleString(getResolvedLocale()) }),
      confirmLabel: t('draftRestore.restore'),
      cancelLabel: t('draftRestore.discard'),
    })
    if (restore) {
      // The draft content itself is not server-side. `savedBase` only means a
      // parent workflow entity exists, so server-backed auxiliary panels may
      // load while autosave/unsaved guards remain active.
      hydrateWorkflow(draft.workflow, { saved: savedBase, dirty: true })
    } else {
      clearDraft(workflowId)
    }
  }, [confirm, hydrateWorkflow, t])

  // Crash recovery: once per app load, offer the most recent draft in this org
  // — it may belong to a never-saved workflow whose random id isn't reachable
  // from the Flows list.
  const draftRecoveryOffered = useRef(false)
  useEffect(() => {
    if (!tenantReady || draftRecoveryOffered.current) return
    draftRecoveryOffered.current = true
    const latest = readLatestDraft()
    if (latest) void maybeRestoreDraft(latest.workflowId)
  }, [tenantReady, maybeRestoreDraft])

  useEffect(() => {
    let mounted = true

    void AuthProvider.getAuth().then((auth) => {
      if (!mounted) return
      setAuth(auth)
    }).catch(() => {
      if (mounted) clearAuth()
    }).finally(() => {
      if (mounted) setAuthReady(true)
    })

    let unsubscribe: (() => void) | undefined
    void AuthProvider.onAuthStateChange((auth) => {
      if (!mounted) return
      if (!auth.session && !auth.userId) clearAuth()
      else setAuth(auth)
    }).then(({ data: listener }) => {
      if (!mounted) listener.subscription.unsubscribe()
      else unsubscribe = () => listener.subscription.unsubscribe()
    }).catch(() => {
      // `getSession` above owns auth readiness. A listener chunk failure is
      // non-fatal and will be retried on the next page load.
    })

    return () => {
      mounted = false
      unsubscribe?.()
    }
  }, [clearAuth, setAuth, setAuthReady])

  // Provider authentication and tenant authorization are separate. Fetch the
  // bounded session context only after the provider has identified the user;
  // this endpoint also works for a legitimate identity with zero memberships.
  useEffect(() => {
    if (!authReady) return
    if (!userId) {
      setIdentityContext(null)
      return
    }

    let cancelled = false
    setIdentityPending()
    void (async () => {
      try {
        const context = await api('/auth/context') as SessionContext
        if (cancelled) return

        // A single membership is an unambiguous server-resolved default. Keep
        // the client preference aligned before any tenant bootstrap request.
        if (context.currentOrganizationId && context.currentOrganizationId !== orgId) {
          const { auth } = await AuthProvider.updateOrg(context.currentOrganizationId)
          if (cancelled) return
          setAuth(auth)
        }
        setIdentityContext(context)
      } catch (error) {
        if (cancelled) return
        setIdentityContext(null)
        addToast(
          error instanceof Error ? error.message : t('auth.context.loadFailed'),
          'error',
        )
      }
    })()

    return () => {
      cancelled = true
    }
  }, [addToast, authReady, orgId, setAuth, setIdentityContext, setIdentityPending, t, userId])

  // Live-run SSE stream (primary). Owns `streamTransport`; on first byte it
  // sets `streamStatus='connected'` and the poll loop below skips its tick. On
  // any stream fault it sets `'polling'` and the very next tick resumes.
  useRunEventStream(runId, projectRunSummary)

  // Terminal-run callback for the poll loop: bump platform version so
  // independent panels re-fetch (cross-panel reactivity), then refetch the
  // shell's platform data. Stable so the poll effect doesn't re-bind per render.
  const onRunTerminal = useCallback(() => {
    bumpPlatformVersion()
    return refreshPlatform()
  }, [bumpPlatformVersion, refreshPlatform])

  // Polling fallback (1.5s `/status`). Loads the initial timeline + stays as the
  // safety net behind SSE. `loadStatus` is reused by the run-action handlers.
  const { loadStatus } = useRunPolling(runId, onRunTerminal, beginRunProjectionUpdate)
  const runPlatformMutation = usePlatformMutation()

  const selectedNode = useMemo(() => nodes.find(node => node.id === selectedNodeId) ?? null, [nodes, selectedNodeId])
  const selectedEdge = useMemo(() => edges.find(edge => edge.id === selectedEdgeId) ?? null, [edges, selectedEdgeId])

  const nodeStatusMap = useMemo(() => {
    return new Map(runNodes.map(node => [node.nodeId, node.status]))
  }, [runNodes])

  // `/runs` intentionally omits the heavy input snapshot. `runDetail` is
  // render-tracked in the store, while this guard rejects every stale open or
  // start response after the operator selects a different run/auth context.
  // An auth-owner transition also clears the complete active-run projection so
  // no prior tenant's nodes or timeline survive while bootstrap data refreshes.
  const runTransitionGuard = useMemo(() => createRunTransitionGuard(
    () => useWorkflowStore.getState().runTransitionGeneration,
  ), [])

  // Pure projections delegated to `./canvas-projections`. The memos
  // depend ONLY on structural inputs — locale-dependent rendering
  // (node label / helper, conditional-edge label) lives inside the
  // leaf components `WorkflowStepNode` and `WorkflowEdge`, both
  // subscribed to language changes via `useT()`. Result: a locale
  // toggle re-renders the leaf components without re-projecting the
  // full graph; a `platformVersion` bump that doesn't actually change
  // the edge list lets React Flow skip downstream work via identity
  // comparison.
  const visibleNodes = useMemo<WorkflowGraphNode[]>(
    () => projectVisibleNodes(nodes, nodeStatusMap, validationIssues, selectedNodeId),
    [nodes, nodeStatusMap, selectedNodeId, validationIssues],
  )
  const visibleEdges = useMemo<WorkflowGraphEdge[]>(
    () => projectVisibleEdges(edges, selectedEdgeId),
    [edges, selectedEdgeId],
  )

  const validateWorkflow = useCallback(async () => {
    if (!canWriteWorkflows) return false
    try {
      const revisionAtRequest = useWorkflowStore.getState().workflowRevision
      const workflow = getWorkflowJson()
      const result = await api('/validate', { method: 'POST', body: JSON.stringify(workflow) }) as ValidationResponse
      // A response for an older graph must not repopulate Problems after the
      // semantic-revision effect has cleared it. Returning false also prevents
      // saveWorkflow from persisting a graph that changed during validation.
      if (useWorkflowStore.getState().workflowRevision !== revisionAtRequest) return false
      setValidationIssues(result.issues ?? [])
      addToast(result.valid ? t('toasts.validationOk') : t('toasts.validationNeedsFix'), result.valid ? 'success' : 'error')
      return result.valid
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('toasts.validationFailed'), 'error')
      return false
    }
  }, [addToast, canWriteWorkflows, getWorkflowJson, t])

  const saveWorkflow = useCallback(async () => {
    if (!canWriteWorkflows) return
    if (!await validateWorkflow()) return

    try {
      const workflow = getWorkflowJson()
      const result = await api('/workflows/save', { method: 'POST', body: JSON.stringify(workflow) }) as { version?: number }
      if (typeof result.version === 'number') setCurrentWorkflowVersion(result.version)
      markWorkflowSaved()
      addToast(t('toasts.savedVersion', { version: result.version ?? '?' }), 'success')
      bumpPlatformVersion()
      await refreshPlatform()
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('toasts.saveFailed'), 'error')
    }
  }, [addToast, bumpPlatformVersion, canWriteWorkflows, getWorkflowJson, markWorkflowSaved, refreshPlatform, t, validateWorkflow])

  const fireSave = useCallback(() => {
    if (canWriteWorkflows) void saveWorkflow()
  }, [canWriteWorkflows, saveWorkflow])
  useKeyboardShortcuts({
    onTogglePalette: togglePalette,
    onToggleShortcuts: toggleShortcuts,
    onFocusSidebarSearch: focusSidebarSearch,
    onSave: fireSave,
    onOpenDestination: openWorkspaceDestination,
    onSignOut: fireSignOut,
  })

  /**
   * Internal helper: send the actual `POST /start` request with an optional
   * typed input. Returns the parsed body so the caller can surface server-
   * side validation errors from `{ errors: string[] }` envelopes (the
   * shape the API emits for typed-input rejections).
   */
  const startRunWith = useCallback(async (input: unknown | undefined): Promise<{ runId?: string; errors?: string[]; discarded?: true }> => {
    const requestId = runTransitionGuard.begin()
    const workflow = getWorkflowJson()
    const body = input !== undefined ? { workflow, input } : workflow
    let result: { runId?: string; errors?: string[] }
    try {
      result = await api('/start', { method: 'POST', body: JSON.stringify(body) }) as { runId?: string; errors?: string[] }
    } catch (error) {
      if (!runTransitionGuard.isCurrent(requestId)) return { discarded: true }
      throw error
    }
    const isCurrentRequest = runTransitionGuard.isCurrent(requestId)
    if (result?.errors) return isCurrentRequest ? result : { discarded: true }
    if (!result?.runId) {
      if (!isCurrentRequest) return { discarded: true }
      throw new Error(t('toasts.apiNoRunId'))
    }
    if (!isCurrentRequest) {
      // The server mutation still happened even if the operator moved on. Keep
      // independent panels fresh, but never launch an unowned shell refresh,
      // activate the stale run, or show its success toast in the new context.
      bumpPlatformVersion()
      return { discarded: true }
    }
    setRunId(result.runId)
    setRunDetail({
      id: result.runId,
      status: 'running',
      inputJson: { workflow, ...(input !== undefined ? { input } : {}) },
    })
    setActiveTab('runs')
    addToast(t('toasts.runStarted', { runIdShort: result.runId.slice(0, 8) }), 'success')
    bumpPlatformVersion()
    await refreshPlatform()
    return result
  }, [addToast, bumpPlatformVersion, getWorkflowJson, refreshPlatform, runTransitionGuard, setActiveTab, setRunDetail, setRunId, t])

  const startWorkflow = useCallback(async () => {
    if (!canStartRuns) return
    // Validation is an authoring capability. A custom operator role may be
    // allowed to start an existing draft without being allowed to edit it;
    // `/start` still performs the authoritative server-side DAG validation.
    if (canWriteWorkflows && !await validateWorkflow()) return
    // Workflows that declared typed `inputs` open the dialog so the
    // operator can provide a payload before we fire `POST /start`.
    if (currentWorkflowInputs) {
      setRunInputServerErrors([])
      setRunInputOpen(true)
      return
    }
    try {
      await startRunWith(undefined)
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('toasts.runFailedToStart'), 'error')
    }
  }, [addToast, canStartRuns, canWriteWorkflows, currentWorkflowInputs, startRunWith, t, validateWorkflow])

  const submitRunInput = useCallback(async (input: unknown) => {
    setRunInputSubmitting(true)
    setRunInputServerErrors([])
    try {
      const result = await startRunWith(input)
      if (result.discarded) return
      if (result?.errors && result.errors.length > 0) {
        setRunInputServerErrors(result.errors)
        return
      }
      setRunInputOpen(false)
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('toasts.runFailedToStart'), 'error')
    } finally {
      setRunInputSubmitting(false)
    }
  }, [addToast, startRunWith, t])

  const openWorkflow = useCallback(async (id: string) => {
    if (!await confirmReplaceCanvas()) return
    try {
      const data = await api(`/workflows/latest?workflowId=${encodeURIComponent(id)}`) as { dagJson?: WorkflowDefinition }
      if (data?.dagJson) {
        hydrateWorkflow(data.dagJson)
        setValidationIssues([])
        setActiveTab('inspector')
        // A local draft newer than the saved version may exist for this
        // workflow (autosaved unsaved edits from a prior session).
        await maybeRestoreDraft(id, true)
      }
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('toasts.workflowOpenFailed'), 'error')
    }
  }, [addToast, confirmReplaceCanvas, hydrateWorkflow, maybeRestoreDraft, setActiveTab, t])

  const openRun = useCallback(async (id: string, targetTab?: ActiveTab) => {
    if (!canReadRuns) return
    // Switch tabs BEFORE the fetch resolves so the panel changes immediately.
    // A caller-pinned `targetTab` is honoured verbatim; otherwise default to the
    // unified Runs workspace. Explicit legacy targets remain honoured for
    // command-palette and expert deep access.
    const requestId = runTransitionGuard.begin()
    setActiveTab(targetTab ?? 'runs')
    try {
      const data = await api(`/run?runId=${encodeURIComponent(id)}`) as RunResponse
      if (!runTransitionGuard.isCurrent(requestId)) return
      setRunId(id)
      if (data.run) setRunDetail(data.run)
      if (data.run) projectRunSummary(id, data.run)
      setRunNodes(data.nodes ?? [])
      setEvents(data.events ?? [])
      setEventsPagination(data.eventsCursor ?? null, Boolean(data.eventsHasMore))
    } catch (error) {
      if (!runTransitionGuard.isCurrent(requestId)) return
      addToast(error instanceof Error ? error.message : t('toasts.runOpenFailed'), 'error')
    }
  }, [addToast, canReadRuns, projectRunSummary, runTransitionGuard, setActiveTab, setEvents, setEventsPagination, setRunDetail, setRunId, setRunNodes, t])

  const loadOlderEvents = useCallback(async () => {
    if (!runId || !eventsCursor || !eventsHasMore) return
    const context = {
      runId,
      generation: useWorkflowStore.getState().runTransitionGeneration,
    }
    try {
      const data = await api(`/run?runId=${encodeURIComponent(runId)}&eventsCursor=${encodeURIComponent(eventsCursor)}`) as RunResponse
      if (!isRunRequestCurrent(context, useWorkflowStore.getState())) return
      addEvents(data.events ?? [])
      setEventsPagination(data.eventsCursor ?? null, Boolean(data.eventsHasMore))
    } catch (error) {
      if (!isRunRequestCurrent(context, useWorkflowStore.getState())) return
      addToast(error instanceof Error ? error.message : t('toasts.olderEventsFailed'), 'error')
    }
  }, [addEvents, addToast, eventsCursor, eventsHasMore, runId, setEventsPagination, t])

  const installPlugin = useCallback(async (pluginId: string) => {
    await runPlatformMutation({
      request: () => api('/plugins/install', { method: 'POST', body: JSON.stringify({ pluginId, config: {} }) }),
      failureMessage: t('toasts.installFailed'),
      successToast: { message: t('toasts.installSucceeded', { pluginId }), tone: 'success' },
      successToastTiming: 'before-effect',
      onSuccess: refreshPlatform,
    })
  }, [refreshPlatform, runPlatformMutation, t])

  const createCredential = useCallback(async (credential: {
    name: string
    kind: string
    secretValue?: string
    secretRef?: string
    expiresAt?: string
  }): Promise<boolean> => {
    const result = await runPlatformMutation({
      request: () => api('/credentials', { method: 'POST', body: JSON.stringify(credential) }),
      failureMessage: t('toasts.credentialFailed'),
      successToast: { message: t('toasts.credentialAdded', { name: credential.name }), tone: 'success' },
      successToastTiming: 'before-effect',
      onSuccess: refreshPlatform,
    })
    return result.ok
  }, [refreshPlatform, runPlatformMutation, t])

  const installPack = useCallback(async (packId: string) => {
    await runPlatformMutation<{ workflowId?: string; missingCredentials?: unknown[] }>({
      request: () => api('/workflows/import-pack', { method: 'POST', body: JSON.stringify({ packId }) }) as Promise<{ workflowId?: string; missingCredentials?: unknown[] }>,
      failureMessage: t('packs.toast.installFailed'),
      successToast: (res) => {
        const missing = Array.isArray(res.missingCredentials) ? res.missingCredentials.length : 0
        return {
          message: missing > 0 ? t('packs.toast.installedWithMissing', { count: missing }) : t('packs.toast.installed'),
          tone: missing > 0 ? 'info' : 'success',
        }
      },
      successToastTiming: 'before-effect',
      onSuccess: async (res) => {
        bumpPlatformVersion()
        await refreshPlatform()
        if (res.workflowId) await openWorkflow(res.workflowId)
      },
    })
  }, [bumpPlatformVersion, openWorkflow, refreshPlatform, runPlatformMutation, t])

  const sampleRunPack = useCallback(async (packId: string) => {
    await runPlatformMutation<{ runId?: string }>({
      request: () => api(`/solution-packs/${encodeURIComponent(packId)}/sample-run`, { method: 'POST', body: JSON.stringify({}) }) as Promise<{ runId?: string }>,
      failureMessage: t('packs.toast.sampleFailed'),
      successToast: { message: t('packs.toast.sampleStarted'), tone: 'success' },
      successToastTiming: 'before-effect',
      onSuccess: async (res) => {
        bumpPlatformVersion()
        await refreshPlatform()
        if (res.runId) await openRun(res.runId, 'runs')
      },
    })
  }, [bumpPlatformVersion, openRun, refreshPlatform, runPlatformMutation, t])

  const openRecoveryQueue = useCallback((deadLetterId?: string) => {
    if (!canReadRuns || !canReadDlq) return
    requestRecoveryQueueFocus(deadLetterId)
    setActiveTab('recover')
  }, [canReadDlq, canReadRuns, setActiveTab])

  // An alert links to `?deadLetterId=<id>`. Consume it once at bootstrap and
  // hand it to the same path an in-app CTA uses, so the operator lands on the
  // exact failure the page was about instead of a queue to hunt through.
  // Runs before paint and only once: re-firing on a later render would yank
  // the operator back to the alert's row after they moved on.
  useEffect(() => {
    const deepLink = consumeDeadLetterDeepLink()
    if (deepLink?.deadLetterId && canReadDlq) openRecoveryQueue(deepLink.deadLetterId)
  }, [canReadDlq, openRecoveryQueue])

  const injectPackFailure = useCallback(async (packId: string, fixtureId: string) => {
    await runPlatformMutation<{ deadLetterId?: string }>({
      request: () => api(
        `/solution-packs/${encodeURIComponent(packId)}/inject-failure`,
        { method: 'POST', body: JSON.stringify({ fixtureId }) },
      ) as Promise<{ deadLetterId?: string }>,
      failureMessage: t('packs.toast.injectFailed'),
      successToast: { message: t('packs.toast.failureInjected'), tone: 'success' },
      successToastTiming: 'before-effect',
      onSuccess: async (result) => {
        bumpPlatformVersion()
        await refreshPlatform()
        openRecoveryQueue(result.deadLetterId)
      },
    })
  }, [bumpPlatformVersion, openRecoveryQueue, refreshPlatform, runPlatformMutation, t])

  const approveNode = useCallback(async (nodeId: string) => {
    if (!runId) return

    await runPlatformMutation({
      request: () => api('/resume', { method: 'POST', body: JSON.stringify({ runId, nodeId }) }),
      failureMessage: t('toasts.resumeFailed'),
      successToast: { message: t('toasts.stepApproved', { nodeId }), tone: 'success' },
      onSuccess: async () => {
        await loadStatus(runId)
      },
    })
  }, [loadStatus, runId, runPlatformMutation, t])

  const submitHumanForm = useCallback(async (nodeId: string, input: unknown, resumeToken: string) => {
    if (!runId) return [t('toasts.formNoActiveRun')]

    try {
      const result = await api('/resume', {
        method: 'POST',
        body: JSON.stringify({ runId, nodeId, input, resumeToken }),
      }) as { errors?: string[] }
      if (Array.isArray(result.errors) && result.errors.length > 0) {
        return result.errors
      }
      await loadStatus(runId)
      bumpPlatformVersion()
      await refreshPlatform()
      addToast(t('toasts.formSubmitted', { nodeId }), 'success')
      return undefined
    } catch (error) {
      const message = error instanceof Error ? error.message : t('toasts.formSubmitFailed')
      addToast(message, 'error')
      return [message]
    }
  }, [addToast, bumpPlatformVersion, loadStatus, refreshPlatform, runId, t])

  const replayNode = useCallback(async (nodeId: string) => {
    if (!runId) return

    await runPlatformMutation({
      request: () => api('/dlq/replay', {
        method: 'POST',
        body: JSON.stringify({ runId, nodeId }),
      }),
      failureMessage: t('toasts.replayFailed'),
      successToast: { message: t('toasts.stepRetried', { nodeId }), tone: 'success' },
      onSuccess: async () => {
        await loadStatus(runId)
        bumpPlatformVersion()
        await refreshPlatform()
      },
    })
  }, [bumpPlatformVersion, loadStatus, refreshPlatform, runId, runPlatformMutation, t])

  // Production redrive (the wedge's last mile): continue THIS failed run from
  // its failed node on the latest saved version — completed upstream work is
  // reused, not re-executed. Opens the continuation run on success.
  const redriveNode = useCallback(async (nodeId: string) => {
    if (!runId) return
    await runPlatformMutation({
      request: () => api('/runs/redrive', {
        method: 'POST',
        body: JSON.stringify({ runId, nodeId }),
      }),
      failureMessage: t('toasts.redriveFailed'),
      successToast: { message: t('toasts.redriveStarted', { nodeId }), tone: 'success' },
      onSuccess: async (result) => {
        bumpPlatformVersion()
        await refreshPlatform()
        const continuation = (result as { runId?: string } | undefined)?.runId
        if (continuation) await openRun(continuation, 'runs')
      },
    })
  }, [bumpPlatformVersion, openRun, refreshPlatform, runId, runPlatformMutation, t])

  const cancelActiveRun = useCallback(async () => {
    if (!runId) return
    const activeRun = projectedRuns.find(r => r.id === runId)
    if (activeRun && isTerminalRunStatus(activeRun.status)) {
      addToast(t('toasts.runAlreadyTerminal', { status: formatStatusLabel(activeRun.status) }), 'info')
      return
    }
    await runPlatformMutation({
      request: () => api('/run/cancel', {
        method: 'POST',
        body: JSON.stringify({ runId, reason: { source: 'ui' } }),
      }),
      failureMessage: t('toasts.runCancelFailed'),
      successToast: { message: t('toasts.runCancelled'), tone: 'success' },
      onSuccess: async () => {
        await loadStatus(runId)
        bumpPlatformVersion()
        await refreshPlatform()
      },
    })
  }, [addToast, bumpPlatformVersion, loadStatus, projectedRuns, refreshPlatform, runId, runPlatformMutation, t])

  const replayDeadLetter = useCallback(async (deadLetterId: string, _createdAtIso?: string) => {
    const result = await runPlatformMutation({
      request: () => api('/dlq/replay', {
        method: 'POST',
        body: JSON.stringify({ deadLetterId }),
      }),
      failureMessage: t('toasts.deadLetterReplayFailed'),
      successToast: { message: t('toasts.deadLetterReplayed'), tone: 'success' },
      onSuccess: async () => {
        if (runId) await loadStatus(runId)
        bumpPlatformVersion()
        await refreshPlatform()
      },
    })
    return result.ok
  }, [bumpPlatformVersion, loadStatus, refreshPlatform, runId, runPlatformMutation, t])

  const generateWorkflow = useCallback(async (prompt: string) => {
    // Guard BEFORE the LLM call: generation replaces the canvas, and a
    // declined confirm shouldn't have burned tokens. `null` = author declined.
    if (!await confirmReplaceCanvas()) return null
    const result = await api('/ai/generate-workflow', {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    }) as GenerateWorkflowResponse

    if (result.error) throw new Error(result.error)
    if (!Array.isArray(result.nodes) || !Array.isArray(result.edges)) {
      throw new Error(t('toasts.aiResponseInvalid'))
    }

    hydrateWorkflow(result, { saved: false, dirty: true })
    setValidationIssues([])
    const mode = result.mode ?? 'fallback'
    const tone = mode === 'error' ? 'error' : result.aiError ? 'info' : 'success'
    const message = mode === 'ai'
      ? t('toasts.aiDrafted')
      : result.aiError
        ? t('toasts.aiFallbackStarter')
        : t('toasts.starterLoaded')
    addToast(message, tone)
    return {
      mode,
      workflow: result as WorkflowDefinition,
      aiError: result.aiError,
      bonBackoff: parseAiCandidateBackoff(result.bonBackoff),
    }
  }, [addToast, confirmReplaceCanvas, hydrateWorkflow, t])

  const explainWorkflow = useCallback(async () => {
    const workflow = getWorkflowJson()
    const result = await api('/ai/explain-workflow', {
      method: 'POST',
      body: JSON.stringify({ workflow }),
    }) as ExplainWorkflowResponse

    if (result.error) throw new Error(result.error)
    return {
      mode: result.mode ?? 'fallback',
      explanation: result.explanation ?? t('toasts.noWorkflowExplanation'),
      model: result.model,
      aiError: result.aiError,
    }
  }, [getWorkflowJson, t])

  const reviewWorkflow = useCallback(async () => {
    setAiReviewIssues([])
    const revisionAtRequest = useWorkflowStore.getState().workflowRevision
    const workflow = getWorkflowJson()
    const result = await api('/ai/review-workflow', {
      method: 'POST',
      body: JSON.stringify({ workflow }),
    }) as ReviewWorkflowResponse

    if (result.error) throw new Error(result.error)
    const review = result.review ?? { status: 'fail' as const, issues: [] }
    if (useWorkflowStore.getState().workflowRevision === revisionAtRequest) {
      setAiReviewIssues(review.issues)
    }
    return {
      mode: result.mode ?? 'fallback',
      review,
      model: result.model,
      aiError: result.aiError,
    }
  }, [getWorkflowJson])

  const resolveDeadLetter = useCallback(async (deadLetterId: string) => {
    const result = await runPlatformMutation({
      request: () => api('/dlq/resolve', {
        method: 'POST',
        body: JSON.stringify({ id: deadLetterId }),
      }),
      failureMessage: t('toasts.deadLetterResolveFailed'),
      successToast: { message: t('toasts.deadLetterResolved'), tone: 'success' },
      onSuccess: async () => {
        bumpPlatformVersion()
        await Promise.all([
          refreshPlatform(),
          requestRecoveryAllClearIfQueueEmpty(),
        ])
      },
    })
    return result.ok
  }, [bumpPlatformVersion, refreshPlatform, runPlatformMutation, t])

  const updateEdgeCondition = useCallback((edgeId: string, condition: string) => {
    storeUpdateEdgeCondition(edgeId, condition || null)
  }, [storeUpdateEdgeCondition])

  const useTemplate = useCallback((workflow: WorkflowDefinition) => {
    void (async () => {
      if (!await confirmReplaceCanvas()) return
      hydrateWorkflow(workflow, { saved: false, dirty: true })
      setValidationIssues([])
      setActiveTab('inspector')
    })()
  }, [confirmReplaceCanvas, hydrateWorkflow, setActiveTab])

  if (!authReady || (userId !== null && !identityReady)) return (
    <div className="boot-screen" role="status" aria-live="polite">
      <div className="boot-screen__inner">
        <BrandMark size={64} />
        <span className="boot-screen__label">{t('app.loading')}</span>
      </div>
    </div>
  )
  if (!userId && isSupabaseConfigured) return <Login onAuthenticated={() => undefined} />
  if (identityContext && !identityContext.currentOrganizationId) {
    return <WorkspaceGate context={identityContext} />
  }

  const env: 'sandbox' | 'production' = (import.meta as { env?: { PROD?: boolean } }).env?.PROD ? 'production' : 'sandbox'
  const envLabel = env === 'production' ? t('topbar.env.production') : t('topbar.env.sandbox')
  const currentOrganizationLabel = currentOrganization?.name ?? orgId ?? 'default'
  const openDlqCount = deadLetters.filter(dlq => dlq.status === 'open').length
  // Waiting is a run-level posture. Semantic quarantine deliberately leaves
  // its source node succeeded, so node-only counting would report all-clear
  // while downstream effects remain contained.
  const blockerCount = countActiveRecoveryBlockers(
    projectedRuns,
    runNodes,
    runId,
    semanticBlockerRunIds,
  )
  const recoverState: 'blocked' | 'attention' | 'clear' =
    blockerCount > 0 ? 'blocked' : openDlqCount > 0 ? 'attention' : 'clear'
  const activeRunCount = projectedRuns.filter(run => run.status === 'running' || run.status === 'paused').length
  const observedRun = runId
    ? (runDetail?.id === runId ? runDetail : projectedRuns.find(run => run.id === runId))
    : undefined
  const isConnected = streamStatus === 'connected'

  // Extracted once so the same element instance can render in either the
  // canvas-tab right rail OR — for non-canvas tabs — directly in the
  // full-width main slot via `<div data-layout="contextual">…</div>`. At
  // any given render only one of the two branches mounts, so React's
  // reconciliation will remount on layout switch (same behavior we'd get
  // from duplicating the JSX literal in both places).
  const rightPanelElement = (
    <RightPanel
      tab={activeTab}
      permissions={tenantPermissions}
      authoring={{
        aiHealth,
        runNodes,
        selectedNode,
        selectedEdge,
        workflowNodes: nodes,
        workflowEdges: edges,
        validationIssues,
        readinessResult,
        aiReviewIssues,
        tools,
        workflows: savedWorkflows,
        currentWorkflowId,
        currentWorkflowName,
        currentWorkflowInputs,
        currentWorkflowOutputs,
        onUpdateNodeConfig: updateSelectedNodeConfig,
        onUpdateNodeType: updateSelectedNodeType,
        onUpdateEdgeCondition: updateEdgeCondition,
        onValidateWorkflow: validateWorkflow,
        onInsertSnippet: () => setSnippetMenuOpen(true),
        onGenerateWorkflow: generateWorkflow,
        onExplainWorkflow: explainWorkflow,
        onReviewWorkflow: reviewWorkflow,
      }}
      catalog={{
        tools,
        templates,
        solutionPacks,
        credentials,
        workflows: savedWorkflows,
        onOpenWorkflow: openWorkflow,
        onCreateWorkflow: () => { void createNewWorkflow('copilot') },
        onUseTemplate: useTemplate,
        onInstallPlugin: installPlugin,
        onInstallPack: installPack,
        onSampleRunPack: sampleRunPack,
        onInjectPackFailure: injectPackFailure,
        onCreateCredential: createCredential,
      }}
      execution={{
        events,
        eventsHasMore,
        onLoadOlderEvents: loadOlderEvents,
        runNodes,
        runs: projectedRuns,
        workflows: savedWorkflows,
        activeRunId: runId,
        usage,
        onOpenRun: openRun,
        onRefreshPlatform: refreshPlatform,
        onApproveNode: approveNode,
        onSubmitHumanForm: submitHumanForm,
        onReplayNode: replayNode,
        onRedriveNode: redriveNode,
        onCancelActiveRun: cancelActiveRun,
        onReplayDeadLetter: replayDeadLetter,
        onResolveDeadLetter: resolveDeadLetter,
      }}
      navigation={{
        onOpenTab: setActiveTab,
        activeRecoveryCaseId,
      }}
    />
  )

  return (
    <Layout
      header={
        <>
          <div className="top-bar-left">
            <BrandMark size={32} />
            <nav className="top-bar-breadcrumb" aria-label={t('layout.workflowStatus')}>
              <span>{currentOrganizationLabel}</span>
              <ChevronRight size={12} aria-hidden="true" />
              <b>{currentWorkflowName}</b>
              <span className={`top-bar-env top-bar-env--${env}`}>{envLabel}</span>
            </nav>
          </div>
          <div className="top-bar-right">
            <div className="top-bar-pill-group">
              {canWriteWorkflows && <WorkflowReadinessBadge onResult={handleReadinessResult} />}
              {tenantPermissions.includes('workflows.read') && (
                <WorkflowHealthBadge workflowId={currentWorkflowSaved ? (currentWorkflowId ?? undefined) : undefined} />
              )}
            </div>
            {canReadRecovery && (
              <button
                type="button"
                className={`top-bar-cta top-bar-cta--${recoverState}`}
                onClick={() => (recoverState === 'clear' ? setActiveTab('home') : openRecoveryQueue())}
                aria-label={
                  recoverState === 'blocked'
                    ? t('topbar.blockerAria', { count: blockerCount })
                    : recoverState === 'attention'
                      ? t('topbar.recoverAria', { count: openDlqCount })
                      : t('topbar.allClearAria')
                }
              >
                {recoverState === 'clear' ? (
                  <>
                    <ShieldCheck size={13} aria-hidden="true" />
                    <span>{t('topbar.allClear')}</span>
                  </>
                ) : (
                  <>
                    <ShieldAlert size={13} aria-hidden="true" />
                    <span>
                      {recoverState === 'blocked'
                        ? t('topbar.blocker', { count: blockerCount })
                        : t('topbar.recover', { count: openDlqCount })}
                    </span>
                  </>
                )}
              </button>
            )}
            <button
              type="button"
              className="top-bar-cmdk"
              onClick={() => setPaletteOpen(true)}
              aria-label={t('topbar.cmdkAria')}
            >
              <Search size={13} aria-hidden="true" />
              <span>{t('topbar.cmdkLabel')}</span>
              <kbd>⌘K</kbd>
            </button>
            <UserMenu
              aiHealth={aiHealth}
              docsUrl={DOCS_URL}
              onOpenTab={setActiveTab}
              onOpenShortcuts={openShortcuts}
            />
          </div>
        </>
      }
      sidebar={
        <BuilderSidebar
          activeTab={activeTab}
          aiHealth={aiHealth}
          workflowName={currentWorkflowName}
          streamStatus={streamStatus}
          workflowEnv={env}
          workflowVersion={currentWorkflowVersion}
          workflowRunsCount={runs.length}
          permissions={tenantPermissions}
          onWorkflowNameChange={setWorkflowName}
          onAdd={addNode}
          onValidate={async () => {
            await validateWorkflow()
          }}
          onSave={saveWorkflow}
          onOpenTab={setActiveTab}
          onOpenHelp={openShortcuts}
          onNew={() => { void createNewWorkflow() }}
          onStart={startWorkflow}
        />
      }
      main={(() => {
        // Layout dispatch driven by `getCanvasVisibility(activeTab, canvasActivated)`:
        //  - `home` (mounted: false) owns the full main slot via
        //    `RecoveryCenterPanel` — no canvas in the DOM at all.
        //  - Canvas tabs (mounted: true, visible: true) mount the canvas
        //    wrapper visibly; the contextual rail does not render
        //    because the right panel takes its place.
        //  - Every other tab renders its contextual slot. Before the first
        //    canvas visit it leaves React Flow unmounted; afterwards it keeps
        //    the existing instance hidden so zoom + pan survive navigation.
        const visibility = getCanvasVisibility(activeTab, canvasActivated)
        if (activeTab === 'home') {
          // Recovery Center renders independently-settled evidence sections;
          // a render fault in one projection must not unmount the whole app.
          return (
            <ErrorBoundary
              resetKey={activeTab}
              logTag="panel:home"
              fallback={({ reset }) => <PanelErrorFallback onRetry={reset} />}
            >
              <Suspense fallback={<div className="panel-list"><p className="helper-text">{t('common.working')}</p></div>}>
                <RecoveryCenterPanel
                  runs={projectedRuns}
                  runNodes={runNodes}
                  deadLetters={deadLetters}
                  onSemanticBlockerRunsChange={setSemanticBlockerRunIds}
                  onOpenTab={setActiveTab}
                  onOpenRecoveryCase={openRecoveryCase}
                  onOpenRun={openRun}
                  onApproveNode={canStartRuns ? approveNode : () => undefined}
                  onOpenRecoveryQueue={() => openRecoveryQueue()}
                  onRefreshPlatform={refreshPlatform}
                  onStartRecoveryDrill={canInstallPacks
                    ? () => injectPackFailure('failed-payment-recovery', 'billing_secret_unbound')
                    : undefined}
                />
              </Suspense>
            </ErrorBoundary>
          )
        }
        return (
          <>
            {visibility.mounted && (
              <div
                className="workspace-canvas-wrapper"
                data-canvas-visible={visibility.visible ? 'true' : 'false'}
                data-testid="workspace-canvas-wrapper"
              >
                <Suspense fallback={<div className="panel-list"><p className="helper-text">{t('common.working')}</p></div>}>
                  <CanvasWorkspace
                    // React Flow only applies `defaultViewport` on mount. Remount
                    // on workflow identity changes so opening a saved workflow
                    // after a reload / Flows navigation can restore its viewport.
                    key={currentWorkflowId ?? 'workflow-canvas'}
                    nodes={visibleNodes}
                    edges={visibleEdges}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onConnect={connect}
                    onNodeClick={handleNodeClick}
                    onEdgeClick={handleEdgeClick}
                    paletteNodeTypes={canvasPaletteTypes}
                    onAddNode={addNode}
                    viewportWorkflowId={currentWorkflowSaved ? (currentWorkflowId ?? undefined) : undefined}
                    active={visibility.visible}
                  />
                </Suspense>
              </div>
            )}
            {visibility.contextualSlot && (
              (activeTab === 'runs' || activeTab === 'reasoning') && observedRun ? (
                <Suspense fallback={<div className="panel-list"><p className="helper-text">{t('common.working')}</p></div>}>
                  <RunObservationWorkspace
                    key={observedRun.id}
                    run={observedRun}
                    runNodes={runNodes}
                    panel={rightPanelElement}
                  />
                </Suspense>
              ) : (
                <div data-layout="contextual">{rightPanelElement}</div>
              )
            )}
          </>
        )
      })()}
      panel={isCanvasTab(activeTab) ? rightPanelElement : null}
      overlay={
        <Suspense fallback={null}>
          <BudgetBlockedBanner onOpenTab={setActiveTab} />
          {runInputOpen && currentWorkflowInputs ? (
            <RunInputDialog
              inputs={currentWorkflowInputs}
              workflowName={currentWorkflowName}
              serverErrors={runInputServerErrors}
              submitting={runInputSubmitting}
              onSubmit={submitRunInput}
              onCancel={() => setRunInputOpen(false)}
            />
          ) : null}
          {paletteOpen && (
          <CommandPalette
            open={paletteOpen}
            onClose={closePalette}
            openTab={setActiveTab}
            onValidate={validateWorkflow}
            onSave={saveWorkflow}
            onStart={startWorkflow}
            onNew={() => { void createNewWorkflow() }}
            onSignOut={fireSignOut}
            docsUrl={DOCS_URL}
            onInsertSnippet={() => setSnippetMenuOpen(true)}
            permissions={tenantPermissions}
            workflows={savedWorkflows.map(wf => ({ id: wf.id, name: wf.name }))}
            recipes={templates.map(template => ({ id: template.id, name: template.name }))}
            onOpenWorkflow={(id) => { void openWorkflow(id) }}
            onOpenRecipe={(id) => {
              const tmpl = templates.find(template => template.id === id)
              if (tmpl) {
                void (async () => {
                  if (!await confirmReplaceCanvas()) return
                  hydrateWorkflow(tmpl.workflow, { saved: false, dirty: true })
                  setValidationIssues([])
                  setActiveTab('inspector')
                })()
              }
            }}
          />
          )}
          {shortcutsOpen && (
            <ShortcutsModal open={shortcutsOpen} onClose={closeShortcuts} permissions={tenantPermissions} />
          )}
          {snippetMenuOpen && <SnippetInsertMenu open={snippetMenuOpen} onClose={closeSnippetMenu} />}
        </Suspense>
      }
      statusBar={
        <>
          <div className="bottom-status-bar__group">
            <span className={`bottom-status-bar__item ${isConnected ? 'bottom-status-bar__item--live' : ''}`}>
              <span className="bottom-status-bar__dot" />
              <span>{isConnected ? t('statusBar.operatorOnline') : t('statusBar.operatorOffline')}</span>
            </span>
            {canReadDlq && (
              <>
                <span className="bottom-status-bar__sep" aria-hidden="true">|</span>
                <span className="bottom-status-bar__item">
                  <Activity size={12} aria-hidden="true" />
                  <span>{t('statusBar.dlq', { dlq: openDlqCount })}</span>
                </span>
              </>
            )}
            {canReadRuns && (
              <>
                <span className="bottom-status-bar__sep" aria-hidden="true">|</span>
                <span className="bottom-status-bar__item">
                  <PlayCircle size={12} aria-hidden="true" />
                  <span>{t('statusBar.activeRuns', { count: activeRunCount })}</span>
                </span>
              </>
            )}
          </div>
          <div className="bottom-status-bar__group bottom-status-bar__group--right">
            {DOCS_URL && (
              <>
                <a
                  className="bottom-status-bar__item"
                  href={DOCS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-testid="status-bar-docs"
                >
                  {t('statusBar.docs')}
                </a>
                <span className="bottom-status-bar__sep" aria-hidden="true">|</span>
              </>
            )}
            <span className="bottom-status-bar__item">
              {currentOrganizationLabel} · build <span>{__BUILD_ID__}</span>
            </span>
            <span className="bottom-status-bar__sep" aria-hidden="true">|</span>
            <button
              type="button"
              className="bottom-status-bar__item bottom-status-bar__item--button"
              onClick={() => setShortcutsOpen(true)}
              aria-label={t('statusBar.shortcuts')}
            >
              <kbd>?</kbd>
              <span>{t('statusBar.shortcuts')}</span>
            </button>
          </div>
        </>
      }
    />
  )
}

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

import React, { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
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
import { RightPanel } from './components/RightPanel'
import { RecoveryCenterPanel } from './components/RecoveryCenterPanel'
import { BudgetBlockedBanner } from './components/BudgetBlockedBanner'
import { OnboardingBanner } from './components/OnboardingBanner'
import { Login } from './components/Login'
import { UserMenu } from './components/UserMenu'
import { WorkflowReadinessBadge } from './components/WorkflowReadinessBadge'
import { WorkflowHealthBadge } from './components/WorkflowHealthBadge'
const RunInputDialog = lazy(() => import('./components/RunInputDialog').then((m) => ({ default: m.RunInputDialog })))
import { Activity, ChevronRight, PlayCircle, Search, ShieldAlert, ShieldCheck } from 'lucide-react'
import { AuthProvider, consumeSsoSessionFragment, isSupabaseConfigured, normalizeAuth } from './auth'
import { useWorkflowStore } from './store'
import { useShallow } from 'zustand/react/shallow'
import { api } from './api'
import { useRunEventStream } from './hooks/useRunEventStream'
import { useBootstrapData } from './hooks/useBootstrapData'
import { useRunPolling } from './hooks/useRunPolling'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { formatStatusLabel } from './constants'
import { projectVisibleEdges, projectVisibleNodes } from './canvas-projections'
import type { ActiveTab, AiMode, RunEvent, RunNode, RunSummary, ValidationIssue, WorkflowDefinition, WorkflowGraphEdge, WorkflowGraphNode } from './types'
import { getCanvasVisibility, isCanvasTab } from './types'
import { isTerminalRunStatus } from '@janusly/shared/src/status'
import { useT } from './i18n'

type RunResponse = {
  run?: RunSummary
  nodes?: RunNode[]
  events?: RunEvent[]
  eventsCursor?: string | null
  eventsHasMore?: boolean
}

type ValidationResponse = {
  valid: boolean
  issues?: ValidationIssue[]
}

type GenerateWorkflowResponse = WorkflowDefinition & {
  mode?: AiMode
  error?: string
  aiError?: string
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
    issues: Array<{
      code: string
      severity: 'info' | 'warn' | 'fail'
      message: string
      nodeId?: string
      edgeId?: string
      rationale: string
      suggestion: string
    }>
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
    session,
    userId,
    orgId,
    authReady,
    runId,
    runNodes,
    events,
    selectedNodeId,
    selectedEdgeId,
    currentWorkflowId,
    currentWorkflowName,
    currentWorkflowSaved,
    currentWorkflowInputs,
    currentWorkflowOutputs,
    streamStatus,
    setAuth,
    clearAuth,
    setAuthReady,
    setActiveTab,
    setWorkflowName,
    hydrateWorkflow,
    getWorkflowJson,
    newWorkflow,
    markWorkflowSaved,
    selectNode,
    selectEdge,
    updateSelectedNodeConfig,
    updateSelectedNodeType,
    setRunId,
    setRunNodes,
    setEvents,
    addEvents,
    eventsCursor,
    eventsHasMore,
    setEventsPagination,
    resetRun,
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
    session: s.session,
    userId: s.userId,
    orgId: s.orgId,
    authReady: s.authReady,
    runId: s.runId,
    runNodes: s.runNodes,
    events: s.events,
    selectedNodeId: s.selectedNodeId,
    selectedEdgeId: s.selectedEdgeId,
    currentWorkflowId: s.currentWorkflowId,
    currentWorkflowName: s.currentWorkflowName,
    currentWorkflowSaved: s.currentWorkflowSaved,
    currentWorkflowInputs: s.currentWorkflowInputs,
    currentWorkflowOutputs: s.currentWorkflowOutputs,
    streamStatus: s.streamStatus,
    setAuth: s.setAuth,
    clearAuth: s.clearAuth,
    setAuthReady: s.setAuthReady,
    setActiveTab: s.setActiveTab,
    setWorkflowName: s.setWorkflowName,
    hydrateWorkflow: s.hydrateWorkflow,
    getWorkflowJson: s.getWorkflowJson,
    newWorkflow: s.newWorkflow,
    markWorkflowSaved: s.markWorkflowSaved,
    selectNode: s.selectNode,
    selectEdge: s.selectEdge,
    updateSelectedNodeConfig: s.updateSelectedNodeConfig,
    updateSelectedNodeType: s.updateSelectedNodeType,
    setRunId: s.setRunId,
    setRunNodes: s.setRunNodes,
    setEvents: s.setEvents,
    addEvents: s.addEvents,
    eventsCursor: s.eventsCursor,
    eventsHasMore: s.eventsHasMore,
    setEventsPagination: s.setEventsPagination,
    resetRun: s.resetRun,
    addToast: s.addToast,
    updateEdgeCondition: s.updateEdgeCondition,
    bumpPlatformVersion: s.bumpPlatformVersion,
  })))

  const { t } = useT()

  const [validationIssues, setValidationIssues] = useState<ValidationIssue[]>([])
  const [currentWorkflowVersion, setCurrentWorkflowVersion] = useState<number | null>(null)
  // Server-data bootstrap (tools / templates / packs / credentials / runs /
  // saved workflows / dead letters / usage / ai-health) + the `refreshPlatform`
  // fan-out, fired once `authReady` flips.
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
  } = useBootstrapData(authReady)
  // Run-input dialog state. Open when the active workflow declares typed
  // `inputs` and the user presses Run; closed otherwise. Server errors
  // (JSONPath strings) are stored separately so the dialog can surface
  // them next to the right field without losing them in a toast.
  const [runInputOpen, setRunInputOpen] = useState(false)
  const [runInputServerErrors, setRunInputServerErrors] = useState<string[]>([])
  const [runInputSubmitting, setRunInputSubmitting] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [snippetMenuOpen, setSnippetMenuOpen] = useState(false)
  // Stable references for the overlay close callbacks. Inline arrows here
  // would create a fresh function ref on every App render — polling at 1.5s
  // plus every Zustand mutation would re-bind the Escape keydown listener
  // inside each modal's `useEffect`. useCallback pins the ref.
  const closePalette = useCallback(() => setPaletteOpen(false), [])
  const closeShortcuts = useCallback(() => setShortcutsOpen(false), [])
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
  const canvasPaletteTypes = useMemo(
    () => (activeTab === 'copilot' ? ['http', 'ai', 'condition', 'tool', 'agent'] : undefined),
    [activeTab],
  )

  // Sign-out driver for the Ctrl+Shift+Q shortcut (same body as the original
  // inline keydown handler: AuthProvider.signOut → clearAuth → toast).
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
  useKeyboardShortcuts({
    onTogglePalette: togglePalette,
    onToggleShortcuts: toggleShortcuts,
    onFocusSidebarSearch: focusSidebarSearch,
    onSignOut: fireSignOut,
  })

  useEffect(() => {
    let mounted = true

    // SSO callback delivers `#janusly_session=<token>` in the URL
    // fragment. Persist it before the auth-state check below runs so the
    // very first API request after login carries the session token.
    consumeSsoSessionFragment()

    AuthProvider.getSession().then(({ data }) => {
      if (!mounted) return
      setAuth(normalizeAuth(data.session))
    }).finally(() => {
      if (mounted) setAuthReady(true)
    })

    const { data: listener } = AuthProvider.onAuthStateChange((auth) => {
      if (!mounted) return
      if (!auth.session && !auth.userId) clearAuth()
      else setAuth(auth)
    })

    return () => {
      mounted = false
      listener?.subscription.unsubscribe()
    }
  }, [clearAuth, setAuth, setAuthReady])

  // Live-run SSE stream (primary). Owns `streamTransport`; on first byte it
  // sets `streamStatus='connected'` and the poll loop below skips its tick. On
  // any stream fault it sets `'polling'` and the very next tick resumes.
  useRunEventStream(runId)

  // Terminal-run callback for the poll loop: bump platform version so
  // independent panels re-fetch (cross-panel reactivity), then refetch the
  // shell's platform data. Stable so the poll effect doesn't re-bind per render.
  const onRunTerminal = useCallback(() => {
    bumpPlatformVersion()
    return refreshPlatform()
  }, [bumpPlatformVersion, refreshPlatform])

  // Polling fallback (1.5s `/status`). Loads the initial timeline + stays as the
  // safety net behind SSE. `loadStatus` is reused by the run-action handlers.
  const { loadStatus } = useRunPolling(runId, onRunTerminal)

  const selectedNode = useMemo(() => nodes.find(node => node.id === selectedNodeId) ?? null, [nodes, selectedNodeId])
  const selectedEdge = useMemo(() => edges.find(edge => edge.id === selectedEdgeId) ?? null, [edges, selectedEdgeId])

  const nodeStatusMap = useMemo(() => {
    return new Map(runNodes.map(node => [node.nodeId, node.status]))
  }, [runNodes])

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
    try {
      const workflow = getWorkflowJson()
      const result = await api('/validate', { method: 'POST', body: JSON.stringify(workflow) }) as ValidationResponse
      setValidationIssues(result.issues ?? [])
      addToast(result.valid ? t('toasts.validationOk') : t('toasts.validationNeedsFix'), result.valid ? 'success' : 'error')
      return result.valid
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('toasts.validationFailed'), 'error')
      return false
    }
  }, [addToast, getWorkflowJson, t])

  const saveWorkflow = useCallback(async () => {
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
  }, [addToast, bumpPlatformVersion, getWorkflowJson, markWorkflowSaved, refreshPlatform, t, validateWorkflow])

  /**
   * Internal helper: send the actual `POST /start` request with an optional
   * typed input. Returns the parsed body so the caller can surface server-
   * side validation errors from `{ errors: string[] }` envelopes (the
   * shape the API emits for typed-input rejections).
   */
  const startRunWith = useCallback(async (input: unknown | undefined): Promise<{ runId?: string; errors?: string[] }> => {
    const workflow = getWorkflowJson()
    const body = input !== undefined ? { workflow, input } : workflow
    const result = await api('/start', { method: 'POST', body: JSON.stringify(body) }) as { runId?: string; errors?: string[] }
    if (result?.errors) return result
    if (!result?.runId) throw new Error(t('toasts.apiNoRunId'))
    resetRun()
    setRunId(result.runId)
    setActiveTab('multiAgent')
    addToast(t('toasts.runStarted', { runIdShort: result.runId.slice(0, 8) }), 'success')
    bumpPlatformVersion()
    await refreshPlatform()
    return result
  }, [addToast, bumpPlatformVersion, getWorkflowJson, refreshPlatform, resetRun, setActiveTab, setRunId, t])

  const startWorkflow = useCallback(async () => {
    if (!await validateWorkflow()) return
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
  }, [addToast, currentWorkflowInputs, startRunWith, t, validateWorkflow])

  const submitRunInput = useCallback(async (input: unknown) => {
    setRunInputSubmitting(true)
    setRunInputServerErrors([])
    try {
      const result = await startRunWith(input)
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
    try {
      const data = await api(`/workflows/latest?workflowId=${encodeURIComponent(id)}`) as { dagJson?: WorkflowDefinition }
      if (data?.dagJson) {
        hydrateWorkflow(data.dagJson)
        setValidationIssues([])
        setActiveTab('inspector')
      }
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('toasts.workflowOpenFailed'), 'error')
    }
  }, [addToast, hydrateWorkflow, setActiveTab, t])

  const openRun = useCallback(async (id: string, targetTab: ActiveTab = 'multiAgent') => {
    try {
      const data = await api(`/run?runId=${encodeURIComponent(id)}`) as RunResponse
      setRunId(id)
      setRunNodes(data.nodes ?? [])
      setEvents(data.events ?? [])
      setEventsPagination(data.eventsCursor ?? null, Boolean(data.eventsHasMore))
      setActiveTab(targetTab)
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('toasts.runOpenFailed'), 'error')
    }
  }, [addToast, setActiveTab, setEvents, setEventsPagination, setRunId, setRunNodes, t])

  const loadOlderEvents = useCallback(async () => {
    if (!runId || !eventsCursor || !eventsHasMore) return
    try {
      const data = await api(`/run?runId=${encodeURIComponent(runId)}&eventsCursor=${encodeURIComponent(eventsCursor)}`) as RunResponse
      addEvents(data.events ?? [])
      setEventsPagination(data.eventsCursor ?? null, Boolean(data.eventsHasMore))
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('toasts.olderEventsFailed'), 'error')
    }
  }, [addEvents, addToast, eventsCursor, eventsHasMore, runId, setEventsPagination, t])

  const installPlugin = useCallback(async (pluginId: string) => {
    try {
      await api('/plugins/install', { method: 'POST', body: JSON.stringify({ pluginId, config: {} }) })
      addToast(t('toasts.installSucceeded', { pluginId }), 'success')
      await refreshPlatform()
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('toasts.installFailed'), 'error')
    }
  }, [addToast, refreshPlatform, t])

  const createCredential = useCallback(async (credential: { name: string; kind: string; secretRef: string }) => {
    try {
      await api('/credentials', { method: 'POST', body: JSON.stringify(credential) })
      addToast(t('toasts.credentialAdded', { name: credential.name }), 'success')
      await refreshPlatform()
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('toasts.credentialFailed'), 'error')
    }
  }, [addToast, refreshPlatform, t])

  const installPack = useCallback(async (packId: string) => {
    try {
      const res = await api('/workflows/import-pack', { method: 'POST', body: JSON.stringify({ packId }) }) as { workflowId?: string; missingCredentials?: unknown[] }
      const missing = Array.isArray(res.missingCredentials) ? res.missingCredentials.length : 0
      addToast(
        missing > 0 ? t('packs.toast.installedWithMissing', { count: missing }) : t('packs.toast.installed'),
        missing > 0 ? 'info' : 'success',
      )
      bumpPlatformVersion()
      await refreshPlatform()
      if (res.workflowId) await openWorkflow(res.workflowId)
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('packs.toast.installFailed'), 'error')
    }
  }, [addToast, bumpPlatformVersion, openWorkflow, refreshPlatform, t])

  const sampleRunPack = useCallback(async (packId: string) => {
    try {
      const res = await api(`/solution-packs/${encodeURIComponent(packId)}/sample-run`, { method: 'POST', body: JSON.stringify({}) }) as { runId?: string }
      addToast(t('packs.toast.sampleStarted'), 'success')
      bumpPlatformVersion()
      await refreshPlatform()
      if (res.runId) await openRun(res.runId, 'runs')
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('packs.toast.sampleFailed'), 'error')
    }
  }, [addToast, bumpPlatformVersion, openRun, refreshPlatform, t])

  const injectPackFailure = useCallback(async (packId: string) => {
    try {
      await api(`/solution-packs/${encodeURIComponent(packId)}/inject-failure`, { method: 'POST', body: JSON.stringify({}) })
      addToast(t('packs.toast.failureInjected'), 'success')
      bumpPlatformVersion()
      await refreshPlatform()
      setActiveTab('runs')
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('packs.toast.injectFailed'), 'error')
    }
  }, [addToast, bumpPlatformVersion, refreshPlatform, setActiveTab, t])

  const approveNode = useCallback(async (nodeId: string) => {
    if (!runId) return

    try {
      await api('/resume', { method: 'POST', body: JSON.stringify({ runId, nodeId }) })
      await loadStatus(runId)
      addToast(t('toasts.stepApproved', { nodeId }), 'success')
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('toasts.resumeFailed'), 'error')
    }
  }, [addToast, loadStatus, runId, t])

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

    try {
      await api('/dlq/replay', {
        method: 'POST',
        body: JSON.stringify({ runId, nodeId }),
      })
      await loadStatus(runId)
      bumpPlatformVersion()
      await refreshPlatform()
      addToast(t('toasts.stepRetried', { nodeId }), 'success')
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('toasts.replayFailed'), 'error')
    }
  }, [addToast, bumpPlatformVersion, loadStatus, refreshPlatform, runId, t])

  const cancelActiveRun = useCallback(async () => {
    if (!runId) return
    const activeRun = runs.find(r => r.id === runId)
    if (activeRun && isTerminalRunStatus(activeRun.status)) {
      addToast(t('toasts.runAlreadyTerminal', { status: formatStatusLabel(activeRun.status) }), 'info')
      return
    }
    try {
      await api('/run/cancel', {
        method: 'POST',
        body: JSON.stringify({ runId, reason: { source: 'ui' } }),
      })
      await loadStatus(runId)
      bumpPlatformVersion()
      await refreshPlatform()
      addToast(t('toasts.runCancelled'), 'success')
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('toasts.runCancelFailed'), 'error')
    }
  }, [addToast, bumpPlatformVersion, loadStatus, refreshPlatform, runId, runs, t])

  const replayDeadLetter = useCallback(async (deadLetterId: string) => {
    try {
      await api('/dlq/replay', {
        method: 'POST',
        body: JSON.stringify({ deadLetterId }),
      })
      if (runId) await loadStatus(runId)
      bumpPlatformVersion()
      await refreshPlatform()
      addToast(t('toasts.deadLetterReplayed'), 'success')
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('toasts.deadLetterReplayFailed'), 'error')
    }
  }, [addToast, bumpPlatformVersion, loadStatus, refreshPlatform, runId, t])

  const generateWorkflow = useCallback(async (prompt: string) => {
    const result = await api('/ai/generate-workflow', {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    }) as GenerateWorkflowResponse

    if (result.error) throw new Error(result.error)
    if (!Array.isArray(result.nodes) || !Array.isArray(result.edges)) {
      throw new Error(t('toasts.aiResponseInvalid'))
    }

    hydrateWorkflow(result)
    setValidationIssues([])
    const mode = result.mode ?? 'fallback'
    const tone = mode === 'error' ? 'error' : result.aiError ? 'info' : 'success'
    const message = mode === 'ai'
      ? t('toasts.aiDrafted')
      : result.aiError
        ? t('toasts.aiFallbackStarter')
        : t('toasts.starterLoaded')
    addToast(message, tone)
    return { mode, workflow: result as WorkflowDefinition, aiError: result.aiError }
  }, [addToast, hydrateWorkflow, t])

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
    const workflow = getWorkflowJson()
    const result = await api('/ai/review-workflow', {
      method: 'POST',
      body: JSON.stringify({ workflow }),
    }) as ReviewWorkflowResponse

    if (result.error) throw new Error(result.error)
    return {
      mode: result.mode ?? 'fallback',
      review: result.review ?? { status: 'fail' as const, issues: [] },
      model: result.model,
      aiError: result.aiError,
    }
  }, [getWorkflowJson])

  const resolveDeadLetter = useCallback(async (deadLetterId: string) => {
    try {
      await api('/dlq/resolve', {
        method: 'POST',
        body: JSON.stringify({ id: deadLetterId }),
      })
      bumpPlatformVersion()
      await refreshPlatform()
      addToast(t('toasts.deadLetterResolved'), 'success')
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('toasts.deadLetterResolveFailed'), 'error')
    }
  }, [addToast, bumpPlatformVersion, refreshPlatform, t])

  const updateEdgeCondition = useCallback((edgeId: string, condition: string) => {
    storeUpdateEdgeCondition(edgeId, condition || null)
  }, [storeUpdateEdgeCondition])

  if (!authReady) return (
    <div className="boot-screen" role="status" aria-live="polite">
      <div className="boot-screen__inner">
        <BrandMark size={64} />
        <span className="boot-screen__label">{t('app.loading')}</span>
      </div>
    </div>
  )
  if (!userId && isSupabaseConfigured) return <Login onAuthenticated={() => undefined} />

  const env: 'sandbox' | 'production' = (import.meta as { env?: { PROD?: boolean } }).env?.PROD ? 'production' : 'sandbox'
  const envLabel = env === 'production' ? t('topbar.env.production') : t('topbar.env.sandbox')
  const openDlqCount = deadLetters.filter(dlq => dlq.status === 'open').length
  // Graduated recovery urgency: red is reserved for an ACTIVE blocker (a run
  // paused on a human gate right now), amber for "there's work" (open DLQ
  // rows), soft green when there's nothing to recover — so the top-bar CTA
  // stops shouting in red on every screen.
  const blockerCount = runNodes.filter(node => node.status === 'waiting').length
  const recoverState: 'blocked' | 'attention' | 'clear' =
    blockerCount > 0 ? 'blocked' : openDlqCount > 0 ? 'attention' : 'clear'
  const activeRunCount = runs.filter(run => run.status === 'running' || run.status === 'paused').length
  const queueCount = 0
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
      events={events}
      eventsHasMore={eventsHasMore}
      onLoadOlderEvents={loadOlderEvents}
      runNodes={runNodes}
      selectedNode={selectedNode}
      selectedEdge={selectedEdge}
      validationIssues={validationIssues}
      tools={tools}
      templates={templates}
      solutionPacks={solutionPacks}
      credentials={credentials}
      runs={runs}
      activeRunId={runId}
      usage={usage}
      aiHealth={aiHealth}
      currentWorkflowName={currentWorkflowName}
      currentWorkflowInputs={currentWorkflowInputs}
      currentWorkflowOutputs={currentWorkflowOutputs}
      onOpenWorkflow={openWorkflow}
      onUseTemplate={(workflow) => {
        hydrateWorkflow(workflow)
        setValidationIssues([])
        setActiveTab('inspector')
      }}
      onInstallPlugin={installPlugin}
      onInstallPack={installPack}
      onSampleRunPack={sampleRunPack}
      onInjectPackFailure={injectPackFailure}
      onCreateCredential={createCredential}
      onOpenRun={openRun}
      onRefreshPlatform={refreshPlatform}
      onUpdateNodeConfig={updateSelectedNodeConfig}
      onUpdateNodeType={updateSelectedNodeType}
      onUpdateEdgeCondition={updateEdgeCondition}
      onInsertSnippet={() => setSnippetMenuOpen(true)}
      onApproveNode={approveNode}
      onSubmitHumanForm={submitHumanForm}
      onReplayNode={replayNode}
      onCancelActiveRun={cancelActiveRun}
      onReplayDeadLetter={replayDeadLetter}
      onResolveDeadLetter={resolveDeadLetter}
      onGenerateWorkflow={generateWorkflow}
      onExplainWorkflow={explainWorkflow}
      onReviewWorkflow={reviewWorkflow}
      onOpenTab={setActiveTab}
    />
  )

  return (
    <Layout
      header={
        <>
          <div className="top-bar-left">
            <BrandMark size={32} />
            <nav className="top-bar-breadcrumb" aria-label={t('layout.workflowStatus')}>
              <span>{orgId ?? 'default'}</span>
              <ChevronRight size={12} aria-hidden="true" />
              <b>{currentWorkflowName}</b>
              <span className={`top-bar-env top-bar-env--${env}`}>{envLabel}</span>
            </nav>
          </div>
          <div className="top-bar-right">
            <div className="top-bar-pill-group">
              <WorkflowReadinessBadge />
              <WorkflowHealthBadge workflowId={currentWorkflowSaved ? (currentWorkflowId ?? undefined) : undefined} />
            </div>
            <button
              type="button"
              className={`top-bar-cta top-bar-cta--${recoverState}`}
              onClick={() => setActiveTab('home')}
              aria-label={
                recoverState === 'blocked'
                  ? t('topbar.blockerAria', { count: blockerCount }) as string
                  : recoverState === 'attention'
                    ? t('topbar.recoverAria', { count: openDlqCount }) as string
                    : t('topbar.allClearAria') as string
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
            <UserMenu aiHealth={aiHealth} onOpenTab={setActiveTab} onOpenShortcuts={() => setShortcutsOpen(true)} />
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
          onWorkflowNameChange={setWorkflowName}
          onAdd={addNode}
          onValidate={validateWorkflow}
          onSave={saveWorkflow}
          onOpenTab={setActiveTab}
          onNew={() => {
            newWorkflow()
            setValidationIssues([])
            setCurrentWorkflowVersion(null)
          }}
          onStart={startWorkflow}
        />
      }
      main={(() => {
        // Layout dispatch driven by `getCanvasVisibility(activeTab)`:
        //  - `home` (mounted: false) owns the full main slot via
        //    `RecoveryCenterPanel` — no canvas in the DOM at all.
        //  - Canvas tabs (mounted: true, visible: true) mount the canvas
        //    wrapper visibly; the contextual rail does not render
        //    because the right panel takes its place.
        //  - Every other tab (mounted: true, visible: false) keeps the
        //    canvas mounted but hidden via `display: none`. The
        //    `<ReactFlowProvider>` lives inside the lazy `CanvasWorkspace`,
        //    so it stays mounted across non-home tabs and holds the React
        //    Flow viewport state — destroying the wrapper would reset zoom +
        //    pan on every navigation back to the editor.
        const visibility = getCanvasVisibility(activeTab)
        if (!visibility.mounted) {
          return (
            <RecoveryCenterPanel
              runs={runs}
              runNodes={runNodes}
              deadLetters={deadLetters}
              activeRunId={runId}
              onOpenTab={setActiveTab}
              onOpenRun={openRun}
              onApproveNode={approveNode}
              onSubmitHumanForm={submitHumanForm}
            />
          )
        }
        return (
          <>
            <div
              className="workspace-canvas-wrapper"
              data-canvas-visible={visibility.visible ? 'true' : 'false'}
              data-testid="workspace-canvas-wrapper"
            >
              <Suspense fallback={<div className="panel-list"><p className="helper-text">{t('common.working')}</p></div>}>
                <CanvasWorkspace
                  nodes={visibleNodes}
                  edges={visibleEdges}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onConnect={connect}
                  onNodeClick={handleNodeClick}
                  onEdgeClick={handleEdgeClick}
                  paletteNodeTypes={canvasPaletteTypes}
                  onAddNode={addNode}
                />
              </Suspense>
            </div>
            {visibility.contextualSlot && (
              <div data-layout="contextual">{rightPanelElement}</div>
            )}
          </>
        )
      })()}
      panel={isCanvasTab(activeTab) ? rightPanelElement : null}
      overlay={
        <Suspense fallback={null}>
          <BudgetBlockedBanner onOpenTab={setActiveTab} />
          <OnboardingBanner onOpenTab={setActiveTab} />
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
            onNew={() => {
              newWorkflow()
              setValidationIssues([])
              setCurrentWorkflowVersion(null)
            }}
            onSignOut={async () => {
              try {
                await AuthProvider.signOut()
                clearAuth()
                addToast(t('toasts.signedOut'), 'info')
              } catch (error) {
                addToast(error instanceof Error ? error.message : t('toasts.signOutFailed'), 'error')
              }
            }}
            onDocsUnavailable={() => addToast(t('statusBar.docsUnavailable'), 'info')}
            onInsertSnippet={() => setSnippetMenuOpen(true)}
            workflows={savedWorkflows.map(wf => ({ id: wf.id, name: wf.name }))}
            recipes={templates.map(template => ({ id: template.id, name: template.name }))}
            onOpenWorkflow={(id) => { void openWorkflow(id) }}
            onOpenRecipe={(id) => {
              const tmpl = templates.find(template => template.id === id)
              if (tmpl) {
                hydrateWorkflow(tmpl.workflow)
                setValidationIssues([])
                setActiveTab('inspector')
              }
            }}
          />
          )}
          {shortcutsOpen && <ShortcutsModal open={shortcutsOpen} onClose={closeShortcuts} />}
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
            <span className="bottom-status-bar__sep" aria-hidden="true">|</span>
            <span className="bottom-status-bar__item">
              <Activity size={12} aria-hidden="true" />
              <span>{t('statusBar.queue', { queue: queueCount, dlq: openDlqCount })}</span>
            </span>
            <span className="bottom-status-bar__sep" aria-hidden="true">|</span>
            <span className="bottom-status-bar__item">
              <PlayCircle size={12} aria-hidden="true" />
              <span>{t('statusBar.activeRuns', { count: activeRunCount })}</span>
            </span>
          </div>
          <div className="bottom-status-bar__group bottom-status-bar__group--right">
            <button
              type="button"
              className="bottom-status-bar__item"
              onClick={() => addToast(t('statusBar.docsUnavailable'), 'info')}
              title={t('statusBar.docsUnavailable')}
              aria-label={t('statusBar.docsUnavailable')}
            >
              {t('statusBar.docs')}
            </button>
            <span className="bottom-status-bar__sep" aria-hidden="true">|</span>
            <span className="bottom-status-bar__item">
              {orgId ?? 'default'} · build <span>2026.05.14-90f3a77</span>
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

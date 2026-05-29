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

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Layout } from './Layout'
import { BrandMark } from './components/BrandMark'
import { BuilderSidebar } from './components/BuilderSidebar'
import { CommandPalette } from './components/CommandPalette'
import { ShortcutsModal } from './components/ShortcutsModal'
import { WorkflowCanvas } from './components/WorkflowCanvas'
import { RightPanel } from './components/RightPanel'
import { RecoveryCenterPanel } from './components/RecoveryCenterPanel'
import { BudgetBlockedBanner } from './components/BudgetBlockedBanner'
import { Login } from './components/Login'
import { UserMenu } from './components/UserMenu'
import { WorkflowReadinessBadge } from './components/WorkflowReadinessBadge'
import { WorkflowHealthBadge } from './components/WorkflowHealthBadge'
import { RunInputDialog } from './components/RunInputDialog'
import { Activity, ChevronRight, PlayCircle, Search, ShieldAlert, ShieldCheck } from 'lucide-react'
import { AuthProvider, consumeSsoSessionFragment, isSupabaseConfigured, normalizeAuth } from './auth'
import { useWorkflowStore } from './store'
import { api } from './api'
import { useRunEventStream } from './hooks/useRunEventStream'
import { formatStatusLabel } from './constants'
import { projectVisibleEdges, projectVisibleNodes } from './canvas-projections'
import type { DeadLetter } from './components/DeadLettersPanel'
import type { AiHealth, AiMode, Credential, RunEvent, RunNode, RunSummary, SavedWorkflow, Template, ToolSchema, ValidationIssue, WorkflowDefinition, WorkflowGraphEdge, WorkflowGraphNode } from './types'
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
    setStreamStatus,
    resetRun,
    addToast,
    updateEdgeCondition: storeUpdateEdgeCondition,
    bumpPlatformVersion,
  } = useWorkflowStore()

  const { t } = useT()

  const [validationIssues, setValidationIssues] = useState<ValidationIssue[]>([])
  const [currentWorkflowVersion, setCurrentWorkflowVersion] = useState<number | null>(null)
  const [tools, setTools] = useState<ToolSchema[]>([])
  const [templates, setTemplates] = useState<Template[]>([])
  const [credentials, setCredentials] = useState<Credential[]>([])
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [savedWorkflows, setSavedWorkflows] = useState<SavedWorkflow[]>([])
  const [deadLetters, setDeadLetters] = useState<DeadLetter[]>([])
  const [usage, setUsage] = useState<Record<string, number>>({})
  const [aiHealth, setAiHealth] = useState<AiHealth | null>(null)
  // Run-input dialog state. Open when the active workflow declares typed
  // `inputs` and the user presses Run; closed otherwise. Server errors
  // (JSONPath strings) are stored separately so the dialog can surface
  // them next to the right field without losing them in a toast.
  const [runInputOpen, setRunInputOpen] = useState(false)
  const [runInputServerErrors, setRunInputServerErrors] = useState<string[]>([])
  const [runInputSubmitting, setRunInputSubmitting] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  // Stable references for the overlay close callbacks. Inline arrows here
  // would create a fresh function ref on every App render — polling at 1.5s
  // plus every Zustand mutation would re-bind the Escape keydown listener
  // inside each modal's `useEffect`. useCallback pins the ref.
  const closePalette = useCallback(() => setPaletteOpen(false), [])
  const closeShortcuts = useCallback(() => setShortcutsOpen(false), [])

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

  // Global keyboard shortcuts:
  //   Cmd/Ctrl+K — toggle command palette
  //   ?         — open keyboard shortcuts overlay (when not typing in an input)
  //   Ctrl+Shift+Q — sign out (matches the kbd shown in the user menu)
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const isTypingInForm = !!target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      )
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen(prev => !prev)
        return
      }
      if (event.key === '?' && !isTypingInForm && !event.metaKey && !event.ctrlKey) {
        event.preventDefault()
        setShortcutsOpen(prev => !prev)
        return
      }
      if (event.key === '/' && !isTypingInForm && !event.metaKey && !event.ctrlKey) {
        // Focus the sidebar search input via a stable data attribute so a
        // future CSS class rename doesn't silently no-op the shortcut.
        const search = document.querySelector<HTMLInputElement>('[data-shortcut="sidebar-search"]')
        if (search) {
          event.preventDefault()
          search.focus()
          search.select()
        }
        return
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'q') {
        event.preventDefault()
        void (async () => {
          try {
            await AuthProvider.signOut()
            clearAuth()
            addToast(t('toasts.signedOut'), 'info')
          } catch (error) {
            addToast(error instanceof Error ? error.message : t('toasts.signOutFailed'), 'error')
          }
        })()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [addToast, clearAuth, t])

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

  const refreshPlatform = useCallback(async () => {
    const [toolData, templateData, credentialData, runData, deadLetterData, usageData, aiHealthData, workflowsData] = await Promise.allSettled([
      api('/tools'),
      api('/templates'),
      api('/credentials'),
      api('/runs'),
      api('/dlq'),
      api('/billing/usage'),
      api('/ai/health'),
      api('/workflows'),
    ])

    if (toolData.status === 'fulfilled') setTools(Array.isArray(toolData.value) ? toolData.value : [])
    if (templateData.status === 'fulfilled') setTemplates(Array.isArray(templateData.value) ? templateData.value : [])
    if (credentialData.status === 'fulfilled') setCredentials(Array.isArray(credentialData.value) ? credentialData.value : [])
    if (runData.status === 'fulfilled') setRuns(Array.isArray(runData.value) ? runData.value : [])
    if (deadLetterData.status === 'fulfilled') setDeadLetters(Array.isArray(deadLetterData.value) ? deadLetterData.value : [])
    if (usageData.status === 'fulfilled' && usageData.value && typeof usageData.value === 'object') {
      setUsage(usageData.value as Record<string, number>)
    }
    if (aiHealthData.status === 'fulfilled' && aiHealthData.value && typeof aiHealthData.value === 'object') {
      setAiHealth(aiHealthData.value as AiHealth)
    }
    if (workflowsData.status === 'fulfilled') setSavedWorkflows(Array.isArray(workflowsData.value) ? workflowsData.value : [])
  }, [])

  useEffect(() => {
    if (authReady) void refreshPlatform()
  }, [authReady, refreshPlatform])

  const loadStatus = useCallback(async (id: string): Promise<RunResponse> => {
    const status = await api(`/status?runId=${encodeURIComponent(id)}`) as RunResponse
    setRunNodes(status.nodes ?? [])
    const statusEvents = status.events ?? []
    addEvents(statusEvents)
    // /status always describes the latest page. Once the user has loaded older
    // pages, preserving the existing cursor prevents polling from rewinding the
    // "Load older events" button back to the first page of history.
    if (typeof status.eventsHasMore === 'boolean') {
      const state = useWorkflowStore.getState()
      const hasLoadedBeyondLatestPage = state.events.length > statusEvents.length
      if (!status.eventsHasMore) {
        setEventsPagination(null, false)
      } else if (!state.eventsCursor && !hasLoadedBeyondLatestPage) {
        setEventsPagination(status.eventsCursor ?? null, true)
      }
    }
    return status
  }, [addEvents, setEventsPagination, setRunNodes])

  // Live-run SSE stream (primary). Owns `streamTransport`; on first byte it
  // sets `streamStatus='connected'` and the poll loop below skips its tick. On
  // any stream fault it sets `'polling'` and the very next tick resumes.
  useRunEventStream(runId)

  // Polling fallback. The original 1.5s `/status` loop loads the initial
  // timeline and stays as the safety net. Its tick is a no-op while SSE is the
  // live transport (a cheap in-memory check, no network) and resumes the moment
  // SSE drops back to `'polling'`. Deps intentionally exclude `streamTransport`
  // so a transport flip never tears the interval down (which would otherwise
  // race the SSE hook's `streamStatus` write).
  useEffect(() => {
    if (!runId) return

    let closed = false
    let stopped = false
    let loadedInitialStatus = false
    setStreamStatus('connecting')

    const tick = async () => {
      // SSE is the live updater after the first status snapshot. Keep the
      // initial `/status` fetch even when SSE connects first; otherwise a
      // node.waiting event published before subscription can be missed and
      // `runNodes` never materializes.
      if (loadedInitialStatus && useWorkflowStore.getState().streamTransport === 'sse') return
      try {
        const status = await loadStatus(runId)
        loadedInitialStatus = true
        if (closed) return
        setStreamStatus('connected')

        if (isTerminalRunStatus(status.run?.status)) {
          stopped = true
          window.clearInterval(interval)
          bumpPlatformVersion()
          await refreshPlatform()
        }
      } catch (error) {
        if (!closed) {
          setStreamStatus('error')
          addToast(error instanceof Error ? error.message : t('toasts.runStatusFailed'), 'error')
        }
      }
    }

    void tick()
    const interval = window.setInterval(() => {
      if (!stopped) void tick()
    }, 1500)

    return () => {
      closed = true
      window.clearInterval(interval)
      setStreamStatus('closed')
    }
  }, [addToast, bumpPlatformVersion, loadStatus, refreshPlatform, runId, setStreamStatus, t])

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

  const openRun = useCallback(async (id: string) => {
    try {
      const data = await api(`/run?runId=${encodeURIComponent(id)}`) as RunResponse
      setRunId(id)
      setRunNodes(data.nodes ?? [])
      setEvents(data.events ?? [])
      setEventsPagination(data.eventsCursor ?? null, Boolean(data.eventsHasMore))
      setActiveTab('multiAgent')
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
      credentials={credentials}
      runs={runs}
      activeRunId={runId}
      deadLetters={deadLetters}
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
      onCreateCredential={createCredential}
      onOpenRun={openRun}
      onRefreshPlatform={refreshPlatform}
      onUpdateNodeConfig={updateSelectedNodeConfig}
      onUpdateNodeType={updateSelectedNodeType}
      onUpdateEdgeCondition={updateEdgeCondition}
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
        //    root-level `<ReactFlowProvider>` (see `main.tsx`) holds the
        //    React Flow viewport state — destroying the wrapper would
        //    reset zoom + pan on every navigation back to the editor.
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
              <WorkflowCanvas
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
            </div>
            {visibility.contextualSlot && (
              <div data-layout="contextual">{rightPanelElement}</div>
            )}
          </>
        )
      })()}
      panel={isCanvasTab(activeTab) ? rightPanelElement : null}
      overlay={
        <>
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
          <ShortcutsModal open={shortcutsOpen} onClose={closeShortcuts} />
        </>
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

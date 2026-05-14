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
import { MarkerType } from '@xyflow/react'
import { BuilderSidebar } from './components/BuilderSidebar'
import { WorkflowCanvas } from './components/WorkflowCanvas'
import { RightPanel } from './components/RightPanel'
import { RecoveryCenterPanel } from './components/RecoveryCenterPanel'
import { BudgetBlockedBanner } from './components/BudgetBlockedBanner'
import { Login } from './components/Login'
import { UserMenu } from './components/UserMenu'
import { WorkflowReadinessBadge } from './components/WorkflowReadinessBadge'
import { WorkflowHealthBadge } from './components/WorkflowHealthBadge'
import { RunInputDialog } from './components/RunInputDialog'
import { AuthProvider, consumeSsoSessionFragment, isSupabaseConfigured, normalizeAuth } from './auth'
import { useWorkflowStore } from './store'
import { api } from './api'
import { getNodeHelper, getNodeLabel } from './constants'
import type { DeadLetter } from './components/DeadLettersPanel'
import type { AiHealth, AiMode, Credential, RunEvent, RunNode, RunSummary, Template, ToolSchema, ValidationIssue, WorkflowDefinition, WorkflowGraphEdge, WorkflowGraphNode } from './types'
import { isTerminalRunStatus } from '@janusly/shared/src/status'

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

  const [validationIssues, setValidationIssues] = useState<ValidationIssue[]>([])
  const [tools, setTools] = useState<ToolSchema[]>([])
  const [templates, setTemplates] = useState<Template[]>([])
  const [credentials, setCredentials] = useState<Credential[]>([])
  const [runs, setRuns] = useState<RunSummary[]>([])
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
    const [toolData, templateData, credentialData, runData, deadLetterData, usageData, aiHealthData] = await Promise.allSettled([
      api('/tools'),
      api('/templates'),
      api('/credentials'),
      api('/runs'),
      api('/dlq'),
      api('/billing/usage'),
      api('/ai/health'),
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

  useEffect(() => {
    if (!runId) return

    let closed = false
    let stopped = false
    setStreamStatus('connecting')

    const tick = async () => {
      try {
        const status = await loadStatus(runId)
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
          addToast(error instanceof Error ? error.message : 'Run status failed', 'error')
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
  }, [addToast, bumpPlatformVersion, loadStatus, refreshPlatform, runId, setStreamStatus])

  const selectedNode = useMemo(() => nodes.find(node => node.id === selectedNodeId) ?? null, [nodes, selectedNodeId])
  const selectedEdge = useMemo(() => edges.find(edge => edge.id === selectedEdgeId) ?? null, [edges, selectedEdgeId])

  const nodeStatusMap = useMemo(() => {
    return new Map(runNodes.map(node => [node.nodeId, node.status]))
  }, [runNodes])

  const visibleNodes = useMemo<WorkflowGraphNode[]>(() => {
    return nodes.map(node => {
      const status = nodeStatusMap.get(node.id) ?? 'pending'
      const hasValidationError = validationIssues.some(issue => issue.nodeId === node.id)
      const isSelected = selectedNodeId === node.id

      return {
        ...node,
        type: 'workflowStep',
        data: {
          ...node.data,
          label: getNodeLabel(node.data.type),
          helper: getNodeHelper(node.data.type),
          status,
          hasValidationError,
        },
        selected: isSelected,
      }
    })
  }, [nodeStatusMap, nodes, selectedNodeId, validationIssues])

  const visibleEdges = useMemo<WorkflowGraphEdge[]>(() => {
    return edges.map(edge => ({
      ...edge,
      animated: Boolean(edge.data?.condition),
      label: edge.data?.condition ? 'condition' : edge.label,
      style: {
        stroke: selectedEdgeId === edge.id ? 'var(--we-primary)' : 'var(--we-faint)',
        strokeWidth: selectedEdgeId === edge.id ? 2.8 : 1.8,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: selectedEdgeId === edge.id ? 'var(--we-primary)' : 'var(--we-faint)',
      },
    }))
  }, [edges, selectedEdgeId])

  const validateWorkflow = useCallback(async () => {
    try {
      const workflow = getWorkflowJson()
      const result = await api('/validate', { method: 'POST', body: JSON.stringify(workflow) }) as ValidationResponse
      setValidationIssues(result.issues ?? [])
      addToast(result.valid ? 'Flow is ready to run' : 'Flow needs a quick fix', result.valid ? 'success' : 'error')
      return result.valid
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Validation failed', 'error')
      return false
    }
  }, [addToast, getWorkflowJson])

  const saveWorkflow = useCallback(async () => {
    if (!await validateWorkflow()) return

    try {
      const workflow = getWorkflowJson()
      const result = await api('/workflows/save', { method: 'POST', body: JSON.stringify(workflow) }) as { version?: number }
      addToast(`Saved version ${result.version ?? '?'}`, 'success')
      bumpPlatformVersion()
      await refreshPlatform()
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Save failed', 'error')
    }
  }, [addToast, bumpPlatformVersion, getWorkflowJson, refreshPlatform, validateWorkflow])

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
    if (!result?.runId) throw new Error('API did not return runId')
    resetRun()
    setRunId(result.runId)
    setActiveTab('multiAgent')
    addToast(`Run started: ${result.runId.slice(0, 8)}`, 'success')
    bumpPlatformVersion()
    await refreshPlatform()
    return result
  }, [addToast, bumpPlatformVersion, getWorkflowJson, refreshPlatform, resetRun, setActiveTab, setRunId])

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
      addToast(error instanceof Error ? error.message : 'Run failed to start', 'error')
    }
  }, [addToast, currentWorkflowInputs, startRunWith, validateWorkflow])

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
      addToast(error instanceof Error ? error.message : 'Run failed to start', 'error')
    } finally {
      setRunInputSubmitting(false)
    }
  }, [addToast, startRunWith])

  const openWorkflow = useCallback(async (id: string) => {
    try {
      const data = await api(`/workflows/latest?workflowId=${encodeURIComponent(id)}`) as { dagJson?: WorkflowDefinition }
      if (data?.dagJson) {
        hydrateWorkflow(data.dagJson)
        setValidationIssues([])
        setActiveTab('inspector')
      }
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Workflow failed to open', 'error')
    }
  }, [addToast, hydrateWorkflow, setActiveTab])

  const openRun = useCallback(async (id: string) => {
    try {
      const data = await api(`/run?runId=${encodeURIComponent(id)}`) as RunResponse
      setRunId(id)
      setRunNodes(data.nodes ?? [])
      setEvents(data.events ?? [])
      setEventsPagination(data.eventsCursor ?? null, Boolean(data.eventsHasMore))
      setActiveTab('multiAgent')
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Run failed to open', 'error')
    }
  }, [addToast, setActiveTab, setEvents, setEventsPagination, setRunId, setRunNodes])

  const loadOlderEvents = useCallback(async () => {
    if (!runId || !eventsCursor || !eventsHasMore) return
    try {
      const data = await api(`/run?runId=${encodeURIComponent(runId)}&eventsCursor=${encodeURIComponent(eventsCursor)}`) as RunResponse
      addEvents(data.events ?? [])
      setEventsPagination(data.eventsCursor ?? null, Boolean(data.eventsHasMore))
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Older events failed to load', 'error')
    }
  }, [addEvents, addToast, eventsCursor, eventsHasMore, runId, setEventsPagination])

  const installPlugin = useCallback(async (pluginId: string) => {
    try {
      await api('/plugins/install', { method: 'POST', body: JSON.stringify({ pluginId, config: {} }) })
      addToast(`Installed ${pluginId}`, 'success')
      await refreshPlatform()
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Tool install failed', 'error')
    }
  }, [addToast, refreshPlatform])

  const createCredential = useCallback(async (credential: { name: string; kind: string; secretRef: string }) => {
    try {
      await api('/credentials', { method: 'POST', body: JSON.stringify(credential) })
      addToast(`Credential ${credential.name} added`, 'success')
      await refreshPlatform()
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Credential failed to save', 'error')
    }
  }, [addToast, refreshPlatform])

  const approveNode = useCallback(async (nodeId: string) => {
    if (!runId) return

    try {
      await api('/resume', { method: 'POST', body: JSON.stringify({ runId, nodeId }) })
      await loadStatus(runId)
      addToast(`Step ${nodeId} approved`, 'success')
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Resume failed', 'error')
    }
  }, [addToast, loadStatus, runId])

  const submitHumanForm = useCallback(async (nodeId: string, input: unknown, resumeToken: string) => {
    if (!runId) return ['No active run is selected.']

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
      addToast(`Form ${nodeId} submitted`, 'success')
      return undefined
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Form submit failed'
      addToast(message, 'error')
      return [message]
    }
  }, [addToast, loadStatus, refreshPlatform, runId])

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
      addToast(`Step ${nodeId} retried`, 'success')
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Replay failed', 'error')
    }
  }, [addToast, bumpPlatformVersion, loadStatus, refreshPlatform, runId])

  const cancelActiveRun = useCallback(async () => {
    if (!runId) return
    const activeRun = runs.find(r => r.id === runId)
    if (activeRun && isTerminalRunStatus(activeRun.status)) {
      addToast(`Run is already ${activeRun.status}`, 'info')
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
      addToast('Run cancelled', 'success')
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Cancel failed', 'error')
    }
  }, [addToast, bumpPlatformVersion, loadStatus, refreshPlatform, runId, runs])

  const replayDeadLetter = useCallback(async (deadLetterId: string) => {
    try {
      await api('/dlq/replay', {
        method: 'POST',
        body: JSON.stringify({ deadLetterId }),
      })
      if (runId) await loadStatus(runId)
      bumpPlatformVersion()
      await refreshPlatform()
      addToast('Dead letter replayed', 'success')
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Dead letter replay failed', 'error')
    }
  }, [addToast, bumpPlatformVersion, loadStatus, refreshPlatform, runId])

  const generateWorkflow = useCallback(async (prompt: string) => {
    const result = await api('/ai/generate-workflow', {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    }) as GenerateWorkflowResponse

    if (result.error) throw new Error(result.error)
    if (!Array.isArray(result.nodes) || !Array.isArray(result.edges)) {
      throw new Error('AI response did not include a runnable workflow.')
    }

    hydrateWorkflow(result)
    setValidationIssues([])
    const mode = result.mode ?? 'fallback'
    const tone = mode === 'error' ? 'error' : result.aiError ? 'info' : 'success'
    const message = mode === 'ai'
      ? 'AI drafted a flow'
      : result.aiError
        ? 'AI failed — starter flow loaded'
        : 'Starter flow loaded locally'
    addToast(message, tone)
    return { mode, workflow: result as WorkflowDefinition, aiError: result.aiError }
  }, [addToast, hydrateWorkflow])

  const explainWorkflow = useCallback(async () => {
    const workflow = getWorkflowJson()
    const result = await api('/ai/explain-workflow', {
      method: 'POST',
      body: JSON.stringify({ workflow }),
    }) as ExplainWorkflowResponse

    if (result.error) throw new Error(result.error)
    return {
      mode: result.mode ?? 'fallback',
      explanation: result.explanation ?? 'No workflow explanation available.',
      model: result.model,
      aiError: result.aiError,
    }
  }, [getWorkflowJson])

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
      addToast('Dead letter resolved', 'success')
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Dead letter resolve failed', 'error')
    }
  }, [addToast, bumpPlatformVersion, refreshPlatform])

  const updateEdgeCondition = useCallback((edgeId: string, condition: string) => {
    storeUpdateEdgeCondition(edgeId, condition || null)
  }, [storeUpdateEdgeCondition])

  if (!authReady) return <div className="boot-screen">Loading Janusly…</div>
  if (!userId && isSupabaseConfigured) return <Login onAuthenticated={() => undefined} />

  return (
    <Layout
      header={
        <>
          <div className="brand-lockup">
            <span className="brand-mark">JN</span>
            <div>
              <strong>Janusly</strong>
              <span>{currentWorkflowName} · {orgId ?? 'default'}</span>
            </div>
          </div>
          <div className="top-bar-status" aria-label="Workflow status">
            <WorkflowReadinessBadge />
            <WorkflowHealthBadge workflowId={currentWorkflowId ?? undefined} />
          </div>
          <UserMenu />
        </>
      }
      sidebar={
        <BuilderSidebar
          activeTab={activeTab}
          aiHealth={aiHealth}
          workflowName={currentWorkflowName}
          streamStatus={streamStatus}
          onWorkflowNameChange={setWorkflowName}
          onAdd={addNode}
          onValidate={validateWorkflow}
          onSave={saveWorkflow}
          onOpenTab={setActiveTab}
          onNew={() => {
            newWorkflow()
            setValidationIssues([])
          }}
          onStart={startWorkflow}
        />
      }
      main={
        activeTab === 'home' ? (
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
        ) : (
          <WorkflowCanvas
            nodes={visibleNodes}
            edges={visibleEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={connect}
            onNodeClick={(_, node) => {
              selectNode(node.id)
              setActiveTab('inspector')
            }}
            onEdgeClick={(_, edge) => {
              selectEdge(edge.id)
              setActiveTab('inspector')
            }}
          />
        )
      }
      panel={activeTab === 'home' ? null : (
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
      )}
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
        </>
      }
    />
  )
}

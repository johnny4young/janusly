import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Layout } from './Layout'
import { MarkerType } from '@xyflow/react'
import { BuilderSidebar } from './components/BuilderSidebar'
import { WorkflowCanvas } from './components/WorkflowCanvas'
import { RightPanel } from './components/RightPanel'
import { Login } from './components/Login'
import { UserMenu } from './components/UserMenu'
import { AuthProvider, isSupabaseConfigured, normalizeAuth } from './auth'
import { useWorkflowStore } from './store'
import { api } from './api'
import { getNodeHelper, getNodeLabel } from './constants'
import type { DeadLetter } from './components/DeadLettersPanel'
import type { AiHealth, AiMode, Credential, RunEvent, RunNode, RunSummary, Template, ToolSchema, ValidationIssue, WorkflowDefinition, WorkflowGraphEdge, WorkflowGraphNode } from './types'

type StatusResponse = {
  run?: RunSummary
  nodes?: RunNode[]
  events?: RunEvent[]
}

const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'canceled'])

type RunResponse = {
  run?: RunSummary
  nodes?: RunNode[]
  events?: RunEvent[]
}

type ValidationResponse = {
  valid: boolean
  issues?: ValidationIssue[]
}

type GenerateWorkflowResponse = WorkflowDefinition & {
  mode?: AiMode
  error?: string
}

type ExplainWorkflowResponse = {
  mode?: AiMode
  explanation?: string
  model?: string
  error?: string
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
    setStreamStatus,
    resetRun,
    addToast,
    setEdges,
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

  useEffect(() => {
    let mounted = true

    AuthProvider.getSession().then(({ data }) => {
      if (!mounted) return
      setAuth(normalizeAuth(data.session))
    }).finally(() => {
      if (mounted) setAuthReady(true)
    })

    const { data: listener } = AuthProvider.onAuthStateChange((auth) => {
      if (!mounted) return
      if (!auth.session && isSupabaseConfigured) clearAuth()
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

  const loadStatus = useCallback(async (id: string): Promise<StatusResponse> => {
    const status = await api(`/status?runId=${encodeURIComponent(id)}`) as StatusResponse
    setRunNodes(status.nodes ?? [])
    setEvents(status.events ?? [])
    return status
  }, [setEvents, setRunNodes])

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

        if (status.run?.status && TERMINAL_RUN_STATUSES.has(status.run.status)) {
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

  const startWorkflow = useCallback(async () => {
    if (!await validateWorkflow()) return

    try {
      const workflow = getWorkflowJson()
      const result = await api('/start', { method: 'POST', body: JSON.stringify(workflow) }) as { runId?: string }
      if (!result.runId) throw new Error('API did not return runId')
      resetRun()
      setRunId(result.runId)
      setActiveTab('crew')
      addToast(`Run started: ${result.runId.slice(0, 8)}`, 'success')
      bumpPlatformVersion()
      await refreshPlatform()
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Run failed to start', 'error')
    }
  }, [addToast, bumpPlatformVersion, getWorkflowJson, refreshPlatform, resetRun, setActiveTab, setRunId, validateWorkflow])

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
      setActiveTab('crew')
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Run failed to open', 'error')
    }
  }, [addToast, setActiveTab, setEvents, setRunId, setRunNodes])

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
    addToast(mode === 'ai' ? 'AI drafted a flow' : 'Starter flow loaded locally', mode === 'error' ? 'error' : 'success')
    return { mode, workflow: result as WorkflowDefinition }
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
    setEdges(edges.map(edge => edge.id === edgeId
      ? { ...edge, data: { ...(edge.data ?? {}), condition: condition || undefined }, label: condition ? 'condition' : undefined }
      : edge
    ))
  }, [edges, setEdges])

  if (!authReady) return <div className="boot-screen">Loading Janusly…</div>
  if (!session && isSupabaseConfigured) return <Login onAuthenticated={() => undefined} />

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
      }
      panel={
        <RightPanel
          tab={activeTab}
          events={events}
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
          onReplayNode={replayNode}
          onReplayDeadLetter={replayDeadLetter}
          onResolveDeadLetter={resolveDeadLetter}
          onGenerateWorkflow={generateWorkflow}
          onExplainWorkflow={explainWorkflow}
          onOpenTab={setActiveTab}
        />
      }
    />
  )
}

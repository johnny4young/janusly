import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Layout } from './Layout'
import { BuilderSidebar } from './components/BuilderSidebar'
import { WorkflowCanvas } from './components/WorkflowCanvas'
import { RightPanel } from './components/RightPanel'
import { Login } from './components/Login'
import { UserMenu } from './components/UserMenu'
import { AuthProvider, isSupabaseConfigured, normalizeAuth } from './auth'
import { useWorkflowStore } from './store'
import { api } from './api'
import { statusStyles } from './constants'
import type { Credential, RunEvent, RunNode, RunSummary, Template, ToolSchema, ValidationIssue, WorkflowDefinition, WorkflowGraphEdge, WorkflowGraphNode } from './types'

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
  const [usage, setUsage] = useState<Record<string, number>>({})

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
    const [toolData, templateData, credentialData, runData, usageData] = await Promise.allSettled([
      api('/tools'),
      api('/templates'),
      api('/credentials'),
      api('/runs'),
      api('/billing/usage'),
    ])

    if (toolData.status === 'fulfilled') setTools(Array.isArray(toolData.value) ? toolData.value : [])
    if (templateData.status === 'fulfilled') setTemplates(Array.isArray(templateData.value) ? templateData.value : [])
    if (credentialData.status === 'fulfilled') setCredentials(Array.isArray(credentialData.value) ? credentialData.value : [])
    if (runData.status === 'fulfilled') setRuns(Array.isArray(runData.value) ? runData.value : [])
    if (usageData.status === 'fulfilled' && usageData.value && typeof usageData.value === 'object') {
      setUsage(usageData.value as Record<string, number>)
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
        data: {
          ...node.data,
          label: `${node.data.label} · ${status}`,
        },
        style: {
          borderRadius: 10,
          padding: 11,
          boxShadow: isSelected
            ? '0 0 0 3px rgba(79, 70, 229, 0.28)'
            : '0 10px 24px -14px rgba(15, 23, 42, 0.18)',
          ...(hasValidationError ? { border: '1.5px solid #ef4444', background: '#fef2f2' } : statusStyles[status] ?? statusStyles.pending),
        },
      }
    })
  }, [nodeStatusMap, nodes, selectedNodeId, validationIssues])

  const visibleEdges = useMemo<WorkflowGraphEdge[]>(() => {
    return edges.map(edge => ({
      ...edge,
      animated: Boolean(edge.data?.condition),
      label: edge.data?.condition ? 'condition' : edge.label,
      style: {
        stroke: selectedEdgeId === edge.id ? '#4f46e5' : '#94a3b8',
        strokeWidth: selectedEdgeId === edge.id ? 2.5 : 1.5,
      },
    }))
  }, [edges, selectedEdgeId])

  const validateWorkflow = useCallback(async () => {
    try {
      const workflow = getWorkflowJson()
      const result = await api('/validate', { method: 'POST', body: JSON.stringify(workflow) }) as ValidationResponse
      setValidationIssues(result.issues ?? [])
      addToast(result.valid ? 'Workflow contract is valid' : 'Workflow has validation issues', result.valid ? 'success' : 'error')
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
      addToast(`Node ${nodeId} resumed`, 'success')
    } catch (error) {
      addToast(error instanceof Error ? error.message : 'Resume failed', 'error')
    }
  }, [addToast, loadStatus, runId])

  const updateEdgeCondition = useCallback((edgeId: string, condition: string) => {
    setEdges(edges.map(edge => edge.id === edgeId
      ? { ...edge, data: { ...(edge.data ?? {}), condition: condition || undefined }, label: condition ? 'condition' : undefined }
      : edge
    ))
  }, [edges, setEdges])

  if (!authReady) return <div className="boot-screen">Loading Workflow Engine…</div>
  if (!session && isSupabaseConfigured) return <Login onAuthenticated={() => undefined} />

  return (
    <Layout
      header={
        <>
          <div className="brand-lockup">
            <span className="brand-mark">WE</span>
            <div>
              <strong>Workflow Engine</strong>
              <span>{currentWorkflowId} / {orgId ?? 'default'}</span>
            </div>
          </div>
          <UserMenu />
        </>
      }
      sidebar={
        <BuilderSidebar
          activeTab={activeTab}
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
          usage={usage}
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
        />
      }
    />
  )
}

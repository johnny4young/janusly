import React, { useEffect } from 'react'
import { Layout } from './Layout'
import { BuilderSidebar } from './components/BuilderSidebar'
import { WorkflowCanvas } from './components/WorkflowCanvas'
import { RightPanel } from './components/RightPanel'
import { Login } from './components/Login'
import { UserMenu } from './components/UserMenu'
import { AuthProvider, normalizeAuth } from './auth'
import { useWorkflowStore } from './store'
import { api } from './api'

export default function AppNext() {
  const {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    connect,
    addNode,
    events,
    activeTab,
    session,
    authReady,
    setAuth,
    clearAuth,
    setAuthReady,
    setActiveTab,
    hydrateWorkflow,
    getWorkflowJson,
    newWorkflow,
    currentWorkflowName,
  } = useWorkflowStore()

  useEffect(() => {
    AuthProvider.getSession().then(({ data }) => {
      const auth = normalizeAuth(data.session)
      setAuth(auth)
    }).finally(() => setAuthReady(true))

    const { data: listener } = AuthProvider.onAuthStateChange((auth) => {
      if (!auth.session) clearAuth()
      else setAuth(auth)
    })

    return () => {
      listener?.subscription.unsubscribe()
    }
  }, [])

  const openWorkflow = async (id: string) => {
    const data = await api(`/workflows/latest?workflowId=${id}`)
    if (data?.dagJson) {
      hydrateWorkflow(data.dagJson)
      setActiveTab('crew')
    }
  }

  const saveWorkflow = async () => {
    const workflow = getWorkflowJson()
    await api('/workflows/save', {
      method: 'POST',
      body: JSON.stringify(workflow)
    })
    setActiveTab('workflows')
  }

  if (!authReady) return <div>Loading...</div>
  if (!session) return <Login onAuthenticated={() => {}} />

  return (
    <Layout
      header={<UserMenu />}
      sidebar={
        <BuilderSidebar
          workflowName={currentWorkflowName}
          onAdd={addNode}
          onValidate={() => {}}
          onSave={saveWorkflow}
          onOpenDashboard={() => setActiveTab('workflows')}
          onNew={newWorkflow}
          onStart={() => {}}
        />
      }
      main={<WorkflowCanvas nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={connect} />}
      panel={<RightPanel tab={activeTab} events={events} onOpenWorkflow={openWorkflow} />}
    />
  )
}

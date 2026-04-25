import React, { useEffect } from 'react'
import { Layout } from './Layout'
import { BuilderSidebar } from './components/BuilderSidebar'
import { WorkflowCanvas } from './components/WorkflowCanvas'
import { RightPanel } from './components/RightPanel'
import { Login } from './components/Login'
import { AuthProvider, normalizeAuth } from './auth'
import { useWorkflowStore } from './store'

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

  if (!authReady) {
    return <div style={{ padding: 20 }}>Loading...</div>
  }

  if (!session) {
    return <Login onAuthenticated={() => {}} />
  }

  return (
    <Layout
      sidebar={<BuilderSidebar onAdd={addNode} onValidate={() => {}} onSave={() => {}} onLoad={() => {}} onStart={() => {}} />}
      main={<WorkflowCanvas nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={connect} />}
      panel={<RightPanel tab={activeTab} events={events} />}
    />
  )
}

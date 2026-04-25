import React, { useEffect, useMemo, useState } from 'react'
import ReactFlow, { addEdge, Background, Controls, useNodesState, useEdgesState } from '@xyflow/react'
import '@xyflow/react/dist/style.css'

type RunNode = {
  nodeId: string
  status: string
}

type RunEvent = {
  id: string
  nodeId?: string | null
  type: string
  payload?: unknown
  createdAt?: string
}

const statusStyles: Record<string, React.CSSProperties> = {
  pending: { border: '2px solid #94a3b8', background: '#f8fafc' },
  queued: { border: '2px solid #f59e0b', background: '#fffbeb' },
  running: { border: '2px solid #3b82f6', background: '#eff6ff' },
  succeeded: { border: '2px solid #22c55e', background: '#f0fdf4' },
  failed: { border: '2px solid #ef4444', background: '#fef2f2' },
}

export default function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState([
    { id: '1', position: { x: 0, y: 0 }, data: { label: 'HTTP' } },
    { id: '2', position: { x: 220, y: 90 }, data: { label: 'Noop' } },
    { id: '3', position: { x: 440, y: 180 }, data: { label: 'Noop' } },
  ])

  const [edges, setEdges, onEdgesChange] = useEdgesState([
    { id: 'e1-2', source: '1', target: '2' },
    { id: 'e2-3', source: '2', target: '3' },
  ])

  const [runId, setRunId] = useState<string | null>(null)
  const [status, setStatus] = useState<{ nodes: RunNode[]; events: RunEvent[] } | null>(null)

  const workflow = {
    id: 'ui-test',
    nodes: nodes.map(n => ({
      id: n.id,
      type: n.id === '1' ? 'http' : 'noop',
      config: n.id === '1' ? { url: 'https://google.com' } : {}
    })),
    edges: edges.map(e => ({ from: e.source, to: e.target }))
  }

  const nodeStatusMap = useMemo(() => {
    const map = new Map<string, string>()
    status?.nodes?.forEach(n => map.set(n.nodeId, n.status))
    return map
  }, [status])

  const visibleNodes = useMemo(() => {
    return nodes.map(node => {
      const nodeStatus = nodeStatusMap.get(node.id) ?? 'pending'
      return {
        ...node,
        data: {
          ...node.data,
          label: `${node.data.label} · ${nodeStatus}`,
        },
        style: {
          borderRadius: 12,
          padding: 8,
          ...statusStyles[nodeStatus],
        },
      }
    })
  }, [nodes, nodeStatusMap])

  const start = async () => {
    const res = await fetch('http://localhost:3001/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(workflow)
    })
    const json = await res.json()
    setRunId(json.runId)
    setStatus(null)
  }

  const loadStatus = async () => {
    if (!runId) return
    const res = await fetch(`http://localhost:3001/status?runId=${runId}`)
    const json = await res.json()
    setStatus(json)
  }

  useEffect(() => {
    if (!runId) return
    const interval = window.setInterval(loadStatus, 1000)
    return () => window.clearInterval(interval)
  }, [runId])

  return (
    <div style={{ height: '100vh', display: 'grid', gridTemplateColumns: '1fr 360px', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <div style={{ height: '100vh' }}>
        <div style={{ padding: 12, display: 'flex', gap: 8, alignItems: 'center', borderBottom: '1px solid #e5e7eb' }}>
          <button onClick={start}>Start Workflow</button>
          <button onClick={loadStatus} disabled={!runId}>Refresh Status</button>
          <span style={{ fontSize: 12, color: '#475569' }}>RunId: {runId ?? 'not started'}</span>
        </div>

        <div style={{ height: 'calc(100vh - 50px)' }}>
          <ReactFlow
            nodes={visibleNodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={(params) => setEdges((eds) => addEdge(params, eds))}
          >
            <Background />
            <Controls />
          </ReactFlow>
        </div>
      </div>

      <aside style={{ borderLeft: '1px solid #e5e7eb', padding: 16, overflow: 'auto', background: '#f8fafc' }}>
        <h2 style={{ marginTop: 0 }}>Execution Timeline</h2>
        {!runId && <p style={{ color: '#64748b' }}>Start a workflow to see execution events.</p>}
        {runId && !status && <p style={{ color: '#64748b' }}>Waiting for status...</p>}

        <section>
          <h3>Nodes</h3>
          {(status?.nodes ?? []).map(node => (
            <div key={node.nodeId} style={{ marginBottom: 8, padding: 10, borderRadius: 10, background: 'white', border: '1px solid #e5e7eb' }}>
              <strong>Node {node.nodeId}</strong>
              <div>Status: {node.status}</div>
            </div>
          ))}
        </section>

        <section>
          <h3>Events</h3>
          {(status?.events ?? []).map(event => (
            <div key={event.id} style={{ marginBottom: 8, padding: 10, borderRadius: 10, background: 'white', border: '1px solid #e5e7eb' }}>
              <strong>{event.type}</strong>
              <div style={{ fontSize: 12, color: '#475569' }}>Node: {event.nodeId ?? 'run'}</div>
              {event.createdAt && <div style={{ fontSize: 12, color: '#64748b' }}>{event.createdAt}</div>}
            </div>
          ))}
        </section>
      </aside>
    </div>
  )
}

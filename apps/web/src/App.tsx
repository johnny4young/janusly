import React, { useEffect, useMemo, useState } from 'react'
import ReactFlow, { addEdge, Background, Controls, useNodesState, useEdgesState } from '@xyflow/react'
import '@xyflow/react/dist/style.css'

type RunNode = { nodeId: string; status: string }
type RunEvent = { id: string; nodeId?: string | null; type: string; payload?: unknown; createdAt?: string }
type WorkflowNodeData = { label: string; type: string; config: Record<string, unknown> }

const statusStyles: Record<string, React.CSSProperties> = {
  pending: { border: '2px solid #94a3b8', background: '#f8fafc' },
  queued: { border: '2px solid #f59e0b', background: '#fffbeb' },
  running: { border: '2px solid #3b82f6', background: '#eff6ff' },
  succeeded: { border: '2px solid #22c55e', background: '#f0fdf4' },
  failed: { border: '2px solid #ef4444', background: '#fef2f2' },
}

const nodePresets: Record<string, Record<string, unknown>> = {
  http: { url: 'https://google.com' },
  noop: {},
  condition: { expression: 'true' },
}

export default function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState([
    { id: '1', position: { x: 0, y: 0 }, data: { label: 'HTTP', type: 'http', config: { url: 'https://google.com' } } },
    { id: '2', position: { x: 220, y: 90 }, data: { label: 'Noop', type: 'noop', config: {} } },
    { id: '3', position: { x: 440, y: 180 }, data: { label: 'Noop', type: 'noop', config: {} } },
  ])
  const [edges, setEdges, onEdgesChange] = useEdgesState([
    { id: 'e1-2', source: '1', target: '2' },
    { id: 'e2-3', source: '2', target: '3' },
  ])
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const [status, setStatus] = useState<{ nodes: RunNode[]; events: RunEvent[] } | null>(null)
  const [saveInfo, setSaveInfo] = useState<string>('')

  const workflow = {
    id: 'ui-test',
    name: 'UI Test Workflow',
    nodes: nodes.map(n => ({
      id: n.id,
      type: (n.data as WorkflowNodeData).type,
      config: (n.data as WorkflowNodeData).config ?? {},
    })),
    edges: edges.map(e => ({ from: e.source, to: e.target }))
  }

  const selectedNode = nodes.find(n => n.id === selectedNodeId)
  const selectedData = selectedNode?.data as WorkflowNodeData | undefined

  const addNode = (type: string) => {
    const id = crypto.randomUUID().slice(0, 8)
    setNodes(current => current.concat({
      id,
      position: { x: 120 + current.length * 80, y: 120 + current.length * 40 },
      data: { label: type.toUpperCase(), type, config: nodePresets[type] ?? {} },
    }))
  }

  const updateSelectedConfig = (raw: string) => {
    if (!selectedNodeId) return
    try {
      const config = JSON.parse(raw)
      setNodes(current => current.map(node => node.id === selectedNodeId ? {
        ...node,
        data: { ...node.data, config }
      } : node))
    } catch {
      // keep editing simple for now; invalid JSON is ignored
    }
  }

  const updateSelectedType = (type: string) => {
    if (!selectedNodeId) return
    setNodes(current => current.map(node => node.id === selectedNodeId ? {
      ...node,
      data: { label: type.toUpperCase(), type, config: nodePresets[type] ?? {} }
    } : node))
  }

  const nodeStatusMap = useMemo(() => {
    const map = new Map<string, string>()
    status?.nodes?.forEach(n => map.set(n.nodeId, n.status))
    return map
  }, [status])

  const visibleNodes = useMemo(() => nodes.map(node => {
    const nodeStatus = nodeStatusMap.get(node.id) ?? 'pending'
    const data = node.data as WorkflowNodeData
    return {
      ...node,
      data: { ...node.data, label: `${data.label} · ${nodeStatus}` },
      style: { borderRadius: 12, padding: 8, ...statusStyles[nodeStatus] },
    }
  }), [nodes, nodeStatusMap])

  const save = async () => {
    const res = await fetch('http://localhost:3001/workflows/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(workflow)
    })
    const json = await res.json()
    setSaveInfo(`Saved v${json.version}`)
  }

  const load = async () => {
    const res = await fetch('http://localhost:3001/workflows/latest?workflowId=ui-test')
    const json = await res.json()
    if (!json?.dagJson) return
    const wf = json.dagJson
    setNodes(wf.nodes.map((n: any, i: number) => ({
      id: n.id,
      position: { x: 80 + i * 220, y: 80 + i * 90 },
      data: { label: n.type.toUpperCase(), type: n.type, config: n.config ?? {} }
    })))
    setEdges(wf.edges.map((e: any, i: number) => ({ id: `e${i}`, source: e.from, target: e.to })))
    setSaveInfo(`Loaded v${json.version}`)
  }

  const start = async () => {
    const res = await fetch('http://localhost:3001/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(workflow)
    })
    const json = await res.json()
    setRunId(json.runId)
    setStatus(null)
  }

  const loadStatus = async () => {
    if (!runId) return
    const res = await fetch(`http://localhost:3001/status?runId=${runId}`)
    setStatus(await res.json())
  }

  useEffect(() => {
    if (!runId) return
    const interval = window.setInterval(loadStatus, 1000)
    return () => window.clearInterval(interval)
  }, [runId])

  return (
    <div style={{ height: '100vh', display: 'grid', gridTemplateColumns: '220px 1fr 380px', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <aside style={{ borderRight: '1px solid #e5e7eb', padding: 16, background: '#f8fafc' }}>
        <h2 style={{ marginTop: 0 }}>Palette</h2>
        {['http', 'noop', 'condition'].map(type => <button key={type} onClick={() => addNode(type)} style={{ display: 'block', width: '100%', marginBottom: 8 }}>{type.toUpperCase()}</button>)}
        <hr />
        <button onClick={save} style={{ width: '100%', marginBottom: 8 }}>Save Workflow</button>
        <button onClick={load} style={{ width: '100%', marginBottom: 8 }}>Load Workflow</button>
        <button onClick={start} style={{ width: '100%', marginBottom: 8 }}>Start Workflow</button>
        <button onClick={loadStatus} disabled={!runId} style={{ width: '100%' }}>Refresh Status</button>
        <p style={{ fontSize: 12, color: '#475569' }}>{saveInfo}</p>
        <p style={{ fontSize: 12, color: '#475569', overflowWrap: 'anywhere' }}>RunId: {runId ?? 'not started'}</p>
      </aside>

      <main style={{ height: '100vh' }}>
        <ReactFlow
          nodes={visibleNodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={(_, node) => setSelectedNodeId(node.id)}
          onConnect={(params) => setEdges((eds) => addEdge(params, eds))}
        >
          <Background />
          <Controls />
        </ReactFlow>
      </main>

      <aside style={{ borderLeft: '1px solid #e5e7eb', padding: 16, overflow: 'auto', background: '#f8fafc' }}>
        <h2 style={{ marginTop: 0 }}>Inspector</h2>
        {!selectedNode && <p style={{ color: '#64748b' }}>Select a node to edit its type and config.</p>}
        {selectedNode && selectedData && <section style={{ marginBottom: 24 }}>
          <label>Node Type</label>
          <select value={selectedData.type} onChange={e => updateSelectedType(e.target.value)} style={{ display: 'block', width: '100%', margin: '8px 0 12px' }}>
            <option value="http">HTTP</option>
            <option value="noop">NOOP</option>
            <option value="condition">CONDITION</option>
          </select>
          <label>Config JSON</label>
          <textarea
            defaultValue={JSON.stringify(selectedData.config, null, 2)}
            onBlur={e => updateSelectedConfig(e.target.value)}
            style={{ width: '100%', minHeight: 120, fontFamily: 'monospace' }}
          />
        </section>}

        <h2>Execution Timeline</h2>
        <section><h3>Nodes</h3>{(status?.nodes ?? []).map(node => <div key={node.nodeId} style={{ marginBottom: 8, padding: 10, borderRadius: 10, background: 'white', border: '1px solid #e5e7eb' }}><strong>Node {node.nodeId}</strong><div>Status: {node.status}</div></div>)}</section>
        <section><h3>Events</h3>{(status?.events ?? []).map(event => <div key={event.id} style={{ marginBottom: 8, padding: 10, borderRadius: 10, background: 'white', border: '1px solid #e5e7eb' }}><strong>{event.type}</strong><div style={{ fontSize: 12, color: '#475569' }}>Node: {event.nodeId ?? 'run'}</div>{event.createdAt && <div style={{ fontSize: 12, color: '#64748b' }}>{event.createdAt}</div>}</div>)}</section>
      </aside>
    </div>
  )
}

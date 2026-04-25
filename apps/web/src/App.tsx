import React, { useState } from 'react'
import ReactFlow, { addEdge, Background, Controls, useNodesState, useEdgesState } from '@xyflow/react'
import '@xyflow/react/dist/style.css'

const initialNodes = [
  { id: '1', position: { x: 0, y: 0 }, data: { label: 'HTTP' } },
  { id: '2', position: { x: 200, y: 100 }, data: { label: 'Noop' } },
]

const initialEdges = [{ id: 'e1-2', source: '1', target: '2' }]

export default function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)
  const [runId, setRunId] = useState<string | null>(null)

  const workflow = {
    id: 'ui-test',
    nodes: nodes.map(n => ({ id: n.id, type: n.id === '1' ? 'http' : 'noop', config: n.id === '1' ? { url: 'https://google.com' } : {} })),
    edges: edges.map(e => ({ from: e.source, to: e.target }))
  }

  const start = async () => {
    const res = await fetch('http://localhost:3001/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(workflow)
    })
    const json = await res.json()
    setRunId(json.runId)
  }

  return (
    <div style={{ height: '100vh' }}>
      <button onClick={start}>Start Workflow</button>
      <div>RunId: {runId}</div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={(params) => setEdges((eds) => addEdge(params, eds))}
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  )
}

import React, { useState } from 'react'
import { useNodesState, useEdgesState, addEdge } from '@xyflow/react'
import { Layout } from './Layout'
import { BuilderSidebar } from './components/BuilderSidebar'
import { WorkflowCanvas } from './components/WorkflowCanvas'
import { RightPanel } from './components/RightPanel'
import { nodePresets } from './constants'

export default function AppNext() {
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [events, setEvents] = useState([])
  const [tab, setTab] = useState('crew')

  const addNode = (type: string) => {
    const id = crypto.randomUUID().slice(0, 8)
    setNodes((n: any) => n.concat({ id, position: { x: 100, y: 100 }, data: { label: type, type, config: nodePresets[type] } }))
  }

  return (
    <Layout
      sidebar={<BuilderSidebar onAdd={addNode} onValidate={() => {}} onSave={() => {}} onLoad={() => {}} onStart={() => {}} />}
      main={<WorkflowCanvas nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={(p: any) => setEdges((e: any) => addEdge(p, e))} />}
      panel={<RightPanel tab={tab} events={events} />}
    />
  )
}

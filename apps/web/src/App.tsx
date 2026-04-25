import React, { useEffect, useMemo, useState } from 'react'
import ReactFlow, { addEdge, Background, Controls, useNodesState, useEdgesState } from '@xyflow/react'
import '@xyflow/react/dist/style.css'

type RunNode = { nodeId: string; status: string }
type RunEvent = { id: string; nodeId?: string | null; type: string; payload?: any; createdAt?: string }
type WorkflowNodeData = { label: string; type: string; config: Record<string, unknown> }
type WorkflowEdgeData = { condition?: string }
type ValidationIssue = { code: string; message: string; nodeId?: string; edgeId?: string }
type ToolSchema = { name: string; description: string; required?: string[]; optional?: string[]; inputExample?: Record<string, unknown> }
type ReplayState = { index: number; nodes: Record<string, string>; currentEvent?: RunEvent }
type ReasoningMessage = { id: string; title: string; body: string; meta?: string; tone: 'info' | 'success' | 'warning' | 'error' }

const statusStyles: Record<string, React.CSSProperties> = {
  pending: { border: '2px solid #94a3b8', background: '#f8fafc' },
  queued: { border: '2px solid #f59e0b', background: '#fffbeb' },
  running: { border: '2px solid #3b82f6', background: '#eff6ff' },
  waiting: { border: '2px solid #a855f7', background: '#faf5ff' },
  skipped: { border: '2px solid #64748b', background: '#f1f5f9' },
  succeeded: { border: '2px solid #22c55e', background: '#f0fdf4' },
  failed: { border: '2px solid #ef4444', background: '#fef2f2' },
}

const messageStyles: Record<ReasoningMessage['tone'], React.CSSProperties> = {
  info: { background: 'white', border: '1px solid #bfdbfe' },
  success: { background: '#f0fdf4', border: '1px solid #bbf7d0' },
  warning: { background: '#fffbeb', border: '1px solid #fde68a' },
  error: { background: '#fff1f2', border: '1px solid #fecdd3' },
}

const nodePresets: Record<string, Record<string, unknown>> = {
  http: { url: 'https://google.com' },
  noop: {},
  condition: { expression: 'true' },
  webhook: {},
  approval: { message: 'Please approve this workflow step.' },
  ai: { provider: 'mock', prompt: 'Summarize this workflow using {{context}}' },
  tool: { tool: 'text.uppercase', input: { value: 'hello' } },
  agent: { planner: 'rules', goal: 'uppercase this text', value: 'hello', maxSteps: 3 },
}

function statusFromEvent(event: RunEvent) {
  if (event.type === 'node.queued') return 'queued'
  if (event.type === 'node.waiting') return 'waiting'
  if (event.type === 'node.succeeded') return 'succeeded'
  if (event.type === 'node.failed') return 'failed'
  if (event.type === 'node.resumed') return 'succeeded'
  return undefined
}

function uniqueEvents(events: RunEvent[]) {
  const seen = new Set<string>()
  return events.filter(event => {
    const key = event.id ?? `${event.type}:${event.nodeId}:${event.createdAt}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function toReasoningMessage(event: RunEvent): ReasoningMessage | null {
  const payload = event.payload ?? {}

  if (event.type === 'agent.started') {
    return { id: event.id, title: 'Agent started', body: `Goal: ${payload.goal ?? 'not provided'}`, meta: `Planner: ${payload.planner ?? 'rules'} · max steps: ${payload.maxSteps ?? '?'}`, tone: 'info' }
  }

  if (event.type === 'agent.step.started') {
    return { id: event.id, title: `Thinking step ${Number(payload.iteration ?? 0) + 1}`, body: 'Planning the next action...', tone: 'info' }
  }

  if (event.type === 'agent.step.planned') {
    const plan = payload.plan ?? {}
    return { id: event.id, title: `Plan: ${plan.tool ?? 'unknown tool'}`, body: plan.reason ?? 'The agent selected a tool.', meta: JSON.stringify(plan.input ?? {}, null, 2), tone: 'warning' }
  }

  if (event.type === 'agent.tool.started' || event.type === 'tool.started') {
    return { id: event.id, title: `Running tool: ${payload.tool ?? 'unknown'}`, body: 'Executing backend tool...', meta: JSON.stringify(payload.input ?? {}, null, 2), tone: 'info' }
  }

  if (event.type === 'agent.tool.completed' || event.type === 'tool.completed') {
    return { id: event.id, title: `Tool completed: ${payload.tool ?? 'unknown'}`, body: 'The tool returned a result.', meta: JSON.stringify(payload.result ?? {}, null, 2), tone: 'success' }
  }

  if (event.type === 'agent.completed') {
    return { id: event.id, title: 'Agent completed', body: payload.finalAnswer ?? payload.reason ?? 'The agent finished execution.', meta: JSON.stringify(payload.finalResult ?? payload.steps ?? {}, null, 2), tone: 'success' }
  }

  if (event.type === 'node.failed') {
    return { id: event.id, title: 'Node failed', body: payload.message ?? 'A node failed during execution.', tone: 'error' }
  }

  return null
}

export default function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState([
    { id: '1', position: { x: 0, y: 0 }, data: { label: 'HTTP', type: 'http', config: { url: 'https://google.com' } } },
    { id: '2', position: { x: 220, y: 90 }, data: { label: 'Approval', type: 'approval', config: { message: 'Approve to continue.' } } },
    { id: '3', position: { x: 440, y: 180 }, data: { label: 'Noop', type: 'noop', config: {} } },
  ])
  const [edges, setEdges, onEdgesChange] = useEdgesState([
    { id: 'e1-2', source: '1', target: '2', data: {} },
    { id: 'e2-3', source: '2', target: '3', data: {} },
  ])
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const [status, setStatus] = useState<{ nodes: RunNode[]; events: RunEvent[] } | null>(null)
  const [saveInfo, setSaveInfo] = useState<string>('')
  const [replayIndex, setReplayIndex] = useState<number | null>(null)
  const [validationIssues, setValidationIssues] = useState<ValidationIssue[]>([])
  const [tools, setTools] = useState<ToolSchema[]>([])
  const [streamStatus, setStreamStatus] = useState<'idle' | 'connecting' | 'connected' | 'closed' | 'error'>('idle')

  const workflow = {
    id: 'ui-test',
    name: 'UI Test Workflow',
    nodes: nodes.map(n => ({ id: n.id, type: (n.data as WorkflowNodeData).type, config: (n.data as WorkflowNodeData).config ?? {} })),
    edges: edges.map(e => ({ from: e.source, to: e.target, condition: (e.data as WorkflowEdgeData | undefined)?.condition || undefined }))
  }

  const reasoningMessages = useMemo(() => (status?.events ?? []).map(toReasoningMessage).filter(Boolean) as ReasoningMessage[], [status])
  const selectedNode = nodes.find(n => n.id === selectedNodeId)
  const selectedData = selectedNode?.data as WorkflowNodeData | undefined
  const selectedEdge = edges.find(e => e.id === selectedEdgeId)
  const selectedEdgeData = selectedEdge?.data as WorkflowEdgeData | undefined
  const selectedToolSchema = selectedData?.type === 'tool' ? tools.find(tool => tool.name === (selectedData.config as any)?.tool) : undefined

  const replayState = useMemo<ReplayState | null>(() => {
    const events = status?.events ?? []
    if (!events.length || replayIndex == null) return null
    const effectiveIndex = Math.min(Math.max(replayIndex, 0), events.length - 1)
    const nodeStates: Record<string, string> = {}
    for (const event of events.slice(0, effectiveIndex + 1)) {
      if (!event.nodeId) continue
      const nextStatus = statusFromEvent(event)
      if (nextStatus) nodeStates[event.nodeId] = nextStatus
    }
    return { index: effectiveIndex, nodes: nodeStates, currentEvent: events[effectiveIndex] }
  }, [status, replayIndex])

  const nodeStatusMap = useMemo(() => {
    const map = new Map<string, string>()
    if (replayState) {
      Object.entries(replayState.nodes).forEach(([nodeId, nodeStatus]) => map.set(nodeId, nodeStatus))
      return map
    }
    status?.nodes?.forEach(n => map.set(n.nodeId, n.status))
    return map
  }, [status, replayState])

  const visibleNodes = useMemo(() => nodes.map(node => {
    const nodeStatus = nodeStatusMap.get(node.id) ?? 'pending'
    const data = node.data as WorkflowNodeData
    const hasValidationError = validationIssues.some(issue => issue.nodeId === node.id)
    return { ...node, data: { ...node.data, label: `${data.label} · ${nodeStatus}${hasValidationError ? ' ⚠' : ''}` }, style: { borderRadius: 12, padding: 8, ...(hasValidationError ? { border: '3px solid #ef4444', background: '#fff1f2' } : statusStyles[nodeStatus]) } }
  }), [nodes, nodeStatusMap, validationIssues])

  const addNode = (type: string) => {
    const id = crypto.randomUUID().slice(0, 8)
    setNodes(current => current.concat({ id, position: { x: 120 + current.length * 80, y: 120 + current.length * 40 }, data: { label: type.toUpperCase(), type, config: nodePresets[type] ?? {} } }))
  }

  const updateSelectedConfigObject = (config: Record<string, unknown>) => {
    if (!selectedNodeId) return
    setNodes(current => current.map(node => node.id === selectedNodeId ? { ...node, data: { ...node.data, config } } : node))
  }

  const updateSelectedConfig = (raw: string) => {
    try { updateSelectedConfigObject(JSON.parse(raw)) } catch {}
  }

  const updateSelectedType = (type: string) => {
    if (!selectedNodeId) return
    setNodes(current => current.map(node => node.id === selectedNodeId ? { ...node, data: { label: type.toUpperCase(), type, config: nodePresets[type] ?? {} } } : node))
  }

  const updateSelectedEdgeCondition = (condition: string) => {
    if (!selectedEdgeId) return
    setEdges(current => current.map(edge => edge.id === selectedEdgeId ? { ...edge, label: condition ? 'condition' : undefined, animated: Boolean(condition), data: { ...(edge.data ?? {}), condition: condition || undefined } } : edge))
  }

  const validate = async () => {
    const res = await fetch('http://localhost:3001/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(workflow) })
    const json = await res.json()
    setValidationIssues(json.issues ?? [])
    return json.valid
  }

  const save = async () => {
    const isValid = await validate()
    if (!isValid) { setSaveInfo('Validation failed'); return }
    const res = await fetch('http://localhost:3001/workflows/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(workflow) })
    const json = await res.json()
    setSaveInfo(json.error ? json.error : `Saved v${json.version}`)
  }

  const load = async () => {
    const res = await fetch('http://localhost:3001/workflows/latest?workflowId=ui-test')
    const json = await res.json()
    if (!json?.dagJson) return
    const wf = json.dagJson
    setNodes(wf.nodes.map((n: any, i: number) => ({ id: n.id, position: { x: 80 + i * 220, y: 80 + i * 90 }, data: { label: n.type.toUpperCase(), type: n.type, config: n.config ?? {} } })))
    setEdges(wf.edges.map((e: any, i: number) => ({ id: `e${i}`, source: e.from, target: e.to, label: e.condition ? 'condition' : undefined, animated: Boolean(e.condition), data: { condition: e.condition } })))
    setSaveInfo(`Loaded v${json.version}`)
  }

  const start = async () => {
    const isValid = await validate()
    if (!isValid) { setSaveInfo('Fix validation errors before starting'); return }
    const res = await fetch('http://localhost:3001/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(workflow) })
    const json = await res.json()
    if (json.error) { setSaveInfo(json.error); return }
    setRunId(json.runId)
    setStatus({ nodes: [], events: [] })
    setReplayIndex(null)
  }

  const loadStatus = async () => {
    if (!runId) return
    const res = await fetch(`http://localhost:3001/status?runId=${runId}`)
    const json = await res.json()
    setStatus(json)
    if (replayIndex == null && json.events?.length) setReplayIndex(json.events.length - 1)
  }

  const approveNode = async (nodeId: string) => {
    if (!runId) return
    await fetch('http://localhost:3001/resume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId, nodeId }) })
    await loadStatus()
  }

  useEffect(() => {
    fetch('http://localhost:3001/tools').then(r => r.json()).then(setTools).catch(() => setTools([]))
  }, [])

  useEffect(() => {
    if (!runId) return
    setStreamStatus('connecting')
    const source = new EventSource(`http://localhost:3001/events?runId=${runId}`)
    source.onopen = () => setStreamStatus('connected')
    source.onmessage = (event) => {
      try {
        const events = JSON.parse(event.data) as RunEvent[]
        setStatus(current => {
          const existingNodes = current?.nodes ?? []
          const mergedEvents = uniqueEvents([...(current?.events ?? []), ...events])
          return { nodes: existingNodes, events: mergedEvents }
        })
        setReplayIndex(events.length ? events.length - 1 : null)
        loadStatus()
      } catch { setStreamStatus('error') }
    }
    source.onerror = () => setStreamStatus('error')
    return () => { source.close(); setStreamStatus('closed') }
  }, [runId])

  const eventCount = status?.events?.length ?? 0

  return (
    <div style={{ height: '100vh', display: 'grid', gridTemplateColumns: '220px 1fr 440px', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <aside style={{ borderRight: '1px solid #e5e7eb', padding: 16, background: '#f8fafc' }}>
        <h2 style={{ marginTop: 0 }}>Palette</h2>
        {['http', 'noop', 'condition', 'webhook', 'approval', 'ai', 'tool', 'agent'].map(type => <button key={type} onClick={() => addNode(type)} style={{ display: 'block', width: '100%', marginBottom: 8 }}>{type.toUpperCase()}</button>)}
        <hr />
        <button onClick={validate} style={{ width: '100%', marginBottom: 8 }}>Validate</button>
        <button onClick={save} style={{ width: '100%', marginBottom: 8 }}>Save Workflow</button>
        <button onClick={load} style={{ width: '100%', marginBottom: 8 }}>Load Workflow</button>
        <button onClick={start} style={{ width: '100%', marginBottom: 8 }}>Start Workflow</button>
        <button onClick={loadStatus} disabled={!runId} style={{ width: '100%' }}>Refresh Status</button>
        <p style={{ fontSize: 12, color: '#475569' }}>{saveInfo}</p>
        <p style={{ fontSize: 12, color: '#475569', overflowWrap: 'anywhere' }}>RunId: {runId ?? 'not started'}</p>
        <p style={{ fontSize: 12, color: streamStatus === 'connected' ? '#16a34a' : '#64748b' }}>Stream: {streamStatus}</p>
      </aside>

      <main style={{ height: '100vh' }}>
        <ReactFlow nodes={visibleNodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onNodeClick={(_, node) => { setSelectedNodeId(node.id); setSelectedEdgeId(null) }} onEdgeClick={(_, edge) => { setSelectedEdgeId(edge.id); setSelectedNodeId(null) }} onConnect={(params) => setEdges((eds) => addEdge({ ...params, data: {} }, eds))}>
          <Background />
          <Controls />
        </ReactFlow>
      </main>

      <aside style={{ borderLeft: '1px solid #e5e7eb', padding: 16, overflow: 'auto', background: '#f8fafc' }}>
        <h2 style={{ marginTop: 0 }}>Agent Reasoning</h2>
        {!reasoningMessages.length && <p style={{ color: '#64748b' }}>Agent/tool trace will appear here during execution.</p>}
        {reasoningMessages.map(message => <div key={message.id} style={{ ...messageStyles[message.tone], borderRadius: 14, padding: 12, marginBottom: 10 }}>
          <strong>{message.title}</strong>
          <p style={{ margin: '6px 0', color: '#334155' }}>{message.body}</p>
          {message.meta && <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', background: '#f8fafc', padding: 8, borderRadius: 8 }}>{message.meta}</pre>}
        </div>)}

        <h2>Validation</h2>
        {!validationIssues.length && <p style={{ color: '#16a34a' }}>No validation issues.</p>}
        {validationIssues.map((issue, i) => <div key={i} style={{ padding: 8, marginBottom: 8, background: '#fff1f2', border: '1px solid #fecdd3', borderRadius: 8 }}><strong>{issue.code}</strong><div>{issue.message}</div></div>)}

        <h2>Inspector</h2>
        {!selectedNode && !selectedEdge && <p style={{ color: '#64748b' }}>Select a node or edge to edit it.</p>}
        {selectedNode && selectedData && <section style={{ marginBottom: 24 }}>
          <h3>Node</h3>
          <label>Node Type</label>
          <select value={selectedData.type} onChange={e => updateSelectedType(e.target.value)} style={{ display: 'block', width: '100%', margin: '8px 0 12px' }}>
            {['http', 'noop', 'condition', 'webhook', 'approval', 'ai', 'tool', 'agent'].map(type => <option key={type} value={type}>{type.toUpperCase()}</option>)}
          </select>
          {selectedData.type === 'tool' && <div style={{ marginBottom: 12, padding: 10, background: 'white', border: '1px solid #e5e7eb', borderRadius: 8 }}>
            <label>Tool</label>
            <select value={String((selectedData.config as any).tool ?? '')} onChange={e => updateSelectedConfigObject({ ...selectedData.config, tool: e.target.value, input: tools.find(t => t.name === e.target.value)?.inputExample ?? {} })} style={{ display: 'block', width: '100%', margin: '8px 0' }}>
              <option value="">Select tool</option>
              {tools.map(tool => <option key={tool.name} value={tool.name}>{tool.name}</option>)}
            </select>
            {selectedToolSchema && <p style={{ fontSize: 12, color: '#475569' }}>{selectedToolSchema.description}. Required: {(selectedToolSchema.required ?? []).join(', ') || 'none'}</p>}
          </div>}
          <label>Config JSON</label>
          <textarea key={selectedNodeId + JSON.stringify(selectedData.config)} defaultValue={JSON.stringify(selectedData.config, null, 2)} onBlur={e => updateSelectedConfig(e.target.value)} style={{ width: '100%', minHeight: 120, fontFamily: 'monospace' }} />
        </section>}

        {selectedEdge && <section style={{ marginBottom: 24 }}><h3>Edge</h3><p style={{ fontSize: 12, color: '#475569' }}>{selectedEdge.source} → {selectedEdge.target}</p><label>Condition Expression</label><textarea defaultValue={selectedEdgeData?.condition ?? ''} onBlur={e => updateSelectedEdgeCondition(e.target.value)} placeholder="context.1.output.statusCode === 200" style={{ width: '100%', minHeight: 90, fontFamily: 'monospace' }} /></section>}

        <h2>Debugger / Replay</h2>
        <section style={{ padding: 10, borderRadius: 10, background: 'white', border: '1px solid #e5e7eb', marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}><button disabled={!eventCount || replayIndex === 0} onClick={() => setReplayIndex(i => Math.max((i ?? 0) - 1, 0))}>Prev</button><button disabled={!eventCount || replayIndex === eventCount - 1} onClick={() => setReplayIndex(i => Math.min((i ?? -1) + 1, eventCount - 1))}>Next</button><button disabled={!eventCount} onClick={() => setReplayIndex(eventCount - 1)}>Live</button></div>
          <div style={{ fontSize: 12, color: '#475569' }}>Step: {eventCount ? (replayIndex ?? 0) + 1 : 0} / {eventCount}</div>
          {replayState?.currentEvent && <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap' }}>{JSON.stringify(replayState.currentEvent, null, 2)}</pre>}
        </section>

        <h2>Execution Timeline</h2>
        <section>{(status?.nodes ?? []).map(node => <div key={node.nodeId} style={{ marginBottom: 8, padding: 10, borderRadius: 10, background: 'white', border: '1px solid #e5e7eb' }}><strong>Node {node.nodeId}</strong><div>Status: {node.status}</div>{node.status === 'waiting' && <button onClick={() => approveNode(node.nodeId)} style={{ marginTop: 8 }}>Approve / Resume</button>}</div>)}</section>
        <section><h3>Events</h3>{(status?.events ?? []).map((event, index) => <div key={event.id} onClick={() => setReplayIndex(index)} style={{ cursor: 'pointer', marginBottom: 8, padding: 10, borderRadius: 10, background: replayIndex === index ? '#e0f2fe' : 'white', border: '1px solid #e5e7eb' }}><strong>{index + 1}. {event.type}</strong><div style={{ fontSize: 12, color: '#475569' }}>Node: {event.nodeId ?? 'run'}</div>{event.createdAt && <div style={{ fontSize: 12, color: '#64748b' }}>{event.createdAt}</div>}</div>)}</section>
      </aside>
    </div>
  )
}

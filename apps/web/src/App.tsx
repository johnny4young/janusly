import React, { useEffect, useMemo, useRef, useState } from 'react'
import ReactFlow, { addEdge, Background, Controls, useNodesState, useEdgesState } from '@xyflow/react'
import '@xyflow/react/dist/style.css'

type RunNode = { nodeId: string; status: string; stateJson?: any; errorJson?: any }
type RunEvent = { id: string; nodeId?: string | null; type: string; payload?: any; createdAt?: string }
type WorkflowNodeData = { label: string; type: string; config: Record<string, unknown> }
type WorkflowEdgeData = { condition?: string }
type ValidationIssue = { code: string; message: string; nodeId?: string; edgeId?: string }
type ToolSchema = { name: string; description: string; required?: string[]; optional?: string[]; inputExample?: Record<string, unknown> }
type Template = { id: string; name: string; description: string; category: string; workflow: any }
type Credential = { id: string; name: string; kind: string; secretRef: string; metadata?: any }
type ReasoningMessage = { id: string; title: string; body: string; meta?: string; tone: 'info' | 'success' | 'warning' | 'error' }

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001'
const authHeaders = { 'x-org-id': 'org_1', 'x-user-id': 'user_1' }

async function api(path: string, options: RequestInit = {}) {
  const headers = { 'Content-Type': 'application/json', ...authHeaders, ...(options.headers ?? {}) }
  const res = await fetch(`${API_URL}${path}`, { ...options, headers })
  return res.json()
}

const nodePresets: Record<string, Record<string, unknown>> = {
  http: { url: 'https://api.github.com' },
  noop: {},
  transform: { mapping: { value: '{{context.1.output.statusCode}}' } },
  condition: { expression: 'true' },
  webhook: {},
  approval: { message: 'Please approve this workflow step.' },
  ai: { provider: 'mock', prompt: 'Summarize this workflow using {{context}}' },
  tool: { tool: 'text.uppercase', input: { value: 'hello' } },
  agent: { planner: 'rules', goal: 'uppercase this text', value: 'hello', maxSteps: 3 },
}

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
  if (event.type === 'agent.started') return { id: event.id, title: 'Agent started', body: `Goal: ${payload.goal ?? 'not provided'}`, meta: `Planner: ${payload.planner ?? 'rules'} · max steps: ${payload.maxSteps ?? '?'}`, tone: 'info' }
  if (event.type === 'agent.step.started') return { id: event.id, title: `Thinking step ${Number(payload.iteration ?? 0) + 1}`, body: 'Planning the next action...', tone: 'info' }
  if (event.type === 'agent.step.planned') return { id: event.id, title: `Plan: ${payload.plan?.tool ?? 'unknown tool'}`, body: payload.plan?.reason ?? 'The agent selected a tool.', meta: JSON.stringify(payload.plan?.input ?? {}, null, 2), tone: 'warning' }
  if (event.type === 'agent.tool.started' || event.type === 'tool.started') return { id: event.id, title: `Running tool: ${payload.tool ?? 'unknown'}`, body: 'Executing backend tool...', meta: JSON.stringify(payload.input ?? {}, null, 2), tone: 'info' }
  if (event.type === 'agent.tool.completed' || event.type === 'tool.completed') return { id: event.id, title: `Tool completed: ${payload.tool ?? 'unknown'}`, body: 'The tool returned a result.', meta: JSON.stringify(payload.result ?? {}, null, 2), tone: 'success' }
  if (event.type === 'agent.completed') return { id: event.id, title: 'Agent completed', body: payload.finalAnswer ?? payload.reason ?? 'The agent finished execution.', meta: JSON.stringify(payload.finalResult ?? payload.steps ?? {}, null, 2), tone: 'success' }
  if (event.type === 'node.failed') return { id: event.id, title: 'Node failed', body: payload.message ?? 'A node failed during execution.', tone: 'error' }
  return null
}

export default function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState([
    { id: '1', position: { x: 0, y: 0 }, data: { label: 'HTTP', type: 'http', config: { url: 'https://api.github.com' } } },
    { id: '2', position: { x: 260, y: 90 }, data: { label: 'AGENT', type: 'agent', config: { planner: 'rules', goal: 'uppercase this text', value: 'hello', maxSteps: 2 } } },
  ])
  const [edges, setEdges, onEdgesChange] = useEdgesState([{ id: 'e1-2', source: '1', target: '2', data: {} }])
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const [status, setStatus] = useState<{ nodes: RunNode[]; events: RunEvent[] }>({ nodes: [], events: [] })
  const [replayIndex, setReplayIndex] = useState<number | null>(null)
  const [validationIssues, setValidationIssues] = useState<ValidationIssue[]>([])
  const [tools, setTools] = useState<ToolSchema[]>([])
  const [templates, setTemplates] = useState<Template[]>([])
  const [credentials, setCredentials] = useState<Credential[]>([])
  const [runs, setRuns] = useState<any[]>([])
  const [usage, setUsage] = useState<Record<string, number>>({})
  const [copilotPrompt, setCopilotPrompt] = useState('Create a workflow that calls an API, transforms the response and explains it with an agent')
  const [activeTab, setActiveTab] = useState<'copilot' | 'marketplace' | 'templates' | 'credentials' | 'inspector' | 'runs' | 'reasoning'>('copilot')
  const [streamStatus, setStreamStatus] = useState<'idle' | 'connecting' | 'connected' | 'closed' | 'error'>('idle')
  const [saveInfo, setSaveInfo] = useState('')
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const workflow = {
    id: 'ui-test',
    name: 'UI Test Workflow',
    nodes: nodes.map(n => ({ id: n.id, type: (n.data as WorkflowNodeData).type, config: (n.data as WorkflowNodeData).config ?? {} })),
    edges: edges.map(e => ({ from: e.source, to: e.target, condition: (e.data as WorkflowEdgeData | undefined)?.condition || undefined }))
  }

  const selectedNode = nodes.find(n => n.id === selectedNodeId)
  const selectedEdge = edges.find(e => e.id === selectedEdgeId)
  const selectedData = selectedNode?.data as WorkflowNodeData | undefined
  const selectedEdgeData = selectedEdge?.data as WorkflowEdgeData | undefined
  const selectedToolSchema = selectedData?.type === 'tool' ? tools.find(tool => tool.name === (selectedData.config as any)?.tool) : undefined
  const selectedRunNode = selectedNodeId ? status.nodes.find(n => n.nodeId === selectedNodeId) : undefined
  const reasoningMessages = useMemo(() => status.events.map(toReasoningMessage).filter(Boolean) as ReasoningMessage[], [status.events])

  const replayState = useMemo(() => {
    if (!status.events.length || replayIndex == null) return null
    const effectiveIndex = Math.min(Math.max(replayIndex, 0), status.events.length - 1)
    const nodeStates: Record<string, string> = {}
    for (const event of status.events.slice(0, effectiveIndex + 1)) {
      if (!event.nodeId) continue
      const nextStatus = statusFromEvent(event)
      if (nextStatus) nodeStates[event.nodeId] = nextStatus
    }
    return { index: effectiveIndex, nodes: nodeStates, currentEvent: status.events[effectiveIndex] }
  }, [status.events, replayIndex])

  const nodeStatusMap = useMemo(() => {
    const map = new Map<string, string>()
    if (replayState) Object.entries(replayState.nodes).forEach(([nodeId, s]) => map.set(nodeId, s))
    else status.nodes.forEach(n => map.set(n.nodeId, n.status))
    return map
  }, [status.nodes, replayState])

  const visibleNodes = useMemo(() => nodes.map(node => {
    const nodeStatus = nodeStatusMap.get(node.id) ?? 'pending'
    const data = node.data as WorkflowNodeData
    const hasValidationError = validationIssues.some(issue => issue.nodeId === node.id)
    return { ...node, data: { ...node.data, label: `${data.label} · ${nodeStatus}${hasValidationError ? ' ⚠' : ''}` }, style: { borderRadius: 12, padding: 8, ...(hasValidationError ? { border: '3px solid #ef4444', background: '#fff1f2' } : statusStyles[nodeStatus]) } }
  }), [nodes, nodeStatusMap, validationIssues])

  const refreshPlatform = async () => {
    const [toolData, templateData, credentialData, runData, usageData] = await Promise.all([
      api('/tools').catch(() => []),
      api('/templates').catch(() => []),
      api('/credentials').catch(() => []),
      api('/runs').catch(() => []),
      api('/billing/usage').catch(() => ({})),
    ])
    setTools(toolData)
    setTemplates(templateData)
    setCredentials(credentialData)
    setRuns(runData)
    setUsage(usageData)
  }

  useEffect(() => { refreshPlatform() }, [])

  useEffect(() => {
    if (!runId) return
    setStreamStatus('connecting')
    const source = new EventSource(`${API_URL}/events?runId=${runId}`)
    source.onopen = () => setStreamStatus('connected')
    source.onmessage = (event) => {
      try {
        const events = JSON.parse(event.data) as RunEvent[]
        setStatus(current => ({ ...current, events: uniqueEvents([...(current.events ?? []), ...events]) }))
        setReplayIndex(events.length ? events.length - 1 : null)
        loadStatus(runId)
      } catch { setStreamStatus('error') }
    }
    source.onerror = () => setStreamStatus('error')
    return () => { source.close(); setStreamStatus('closed') }
  }, [runId])

  const hydrateWorkflow = (wf: any) => {
    setNodes(wf.nodes.map((n: any, i: number) => ({ id: n.id, position: { x: 80 + i * 230, y: 80 + (i % 3) * 120 }, data: { label: n.type.toUpperCase(), type: n.type, config: n.config ?? {} } })))
    setEdges(wf.edges.map((e: any, i: number) => ({ id: `e${i}`, source: e.from, target: e.to, label: e.condition ? 'condition' : undefined, animated: Boolean(e.condition), data: { condition: e.condition } })))
    setValidationIssues([])
  }

  const addNode = (type: string) => {
    const id = crypto.randomUUID().slice(0, 8)
    setNodes(current => current.concat({ id, position: { x: 120 + current.length * 80, y: 120 + current.length * 40 }, data: { label: type.toUpperCase(), type, config: nodePresets[type] ?? {} } }))
  }

  const updateSelectedConfigObject = (config: Record<string, unknown>) => {
    if (!selectedNodeId) return
    setNodes(current => current.map(node => node.id === selectedNodeId ? { ...node, data: { ...node.data, config } } : node))
  }

  const updateSelectedType = (type: string) => {
    if (!selectedNodeId) return
    setNodes(current => current.map(node => node.id === selectedNodeId ? { ...node, data: { label: type.toUpperCase(), type, config: nodePresets[type] ?? {} } } : node))
  }

  const validate = async () => {
    const json = await api('/validate', { method: 'POST', body: JSON.stringify(workflow) })
    setValidationIssues(json.issues ?? [])
    return json.valid
  }

  const start = async () => {
    const isValid = await validate()
    if (!isValid) return setSaveInfo('Fix validation errors before starting')
    const json = await api('/start', { method: 'POST', body: JSON.stringify(workflow) })
    if (json.error) return setSaveInfo(json.error)
    setRunId(json.runId)
    setStatus({ nodes: [], events: [] })
    setReplayIndex(null)
    setSaveInfo(`Started ${json.runId}`)
  }

  const save = async () => {
    const isValid = await validate()
    if (!isValid) return setSaveInfo('Validation failed')
    const json = await api('/workflows/save', { method: 'POST', body: JSON.stringify(workflow) })
    setSaveInfo(json.error ? json.error : `Saved v${json.version}`)
  }

  const load = async () => {
    const json = await api('/workflows/latest?workflowId=ui-test')
    if (json?.dagJson) hydrateWorkflow(json.dagJson)
  }

  const loadStatus = async (id = runId) => {
    if (!id) return
    const json = await api(`/status?runId=${id}`)
    if (!json.error) {
      setStatus({ nodes: json.nodes ?? [], events: json.events ?? [] })
      if (replayIndex == null && json.events?.length) setReplayIndex(json.events.length - 1)
    }
  }

  const openRun = async (id: string) => {
    setRunId(id)
    const json = await api(`/run?runId=${id}`)
    if (!json.error) {
      setStatus({ nodes: json.nodes ?? [], events: json.events ?? [] })
      setReplayIndex(json.events?.length ? json.events.length - 1 : null)
      setActiveTab('reasoning')
    }
  }

  const approveNode = async (nodeId: string) => {
    if (!runId) return
    await api('/resume', { method: 'POST', body: JSON.stringify({ runId, nodeId }) })
    await loadStatus()
  }

  const runCopilot = async () => {
    const wf = await api('/ai/generate-workflow', { method: 'POST', body: JSON.stringify({ prompt: copilotPrompt }) })
    if (wf?.nodes && wf?.edges) hydrateWorkflow(wf)
  }

  const explainWorkflow = async () => {
    const res = await api('/ai/explain-workflow', { method: 'POST', body: JSON.stringify({ workflow }) })
    alert(res.explanation ?? 'No explanation available')
  }

  const installPlugin = async (pluginId: string) => {
    await api('/plugins/install', { method: 'POST', body: JSON.stringify({ pluginId, config: {} }) })
    await refreshPlatform()
  }

  const createCredential = async () => {
    const name = prompt('Credential name?') || 'API Key'
    const kind = prompt('Kind? e.g. slack, stripe, generic') || 'generic'
    const secretRef = prompt('Secret env ref? e.g. SLACK_BOT_TOKEN') || 'MY_SECRET'
    await api('/credentials', { method: 'POST', body: JSON.stringify({ name, kind, secretRef }) })
    await refreshPlatform()
  }

  const exportWorkflow = () => {
    const blob = new Blob([JSON.stringify(workflow, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${workflow.id}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  const importWorkflow = async (file: File) => {
    const text = await file.text()
    hydrateWorkflow(JSON.parse(text))
  }

  const tabButton = (id: typeof activeTab, label: string) => <button onClick={() => setActiveTab(id)} style={{ width: '100%', marginBottom: 6, background: activeTab === id ? '#dbeafe' : 'white' }}>{label}</button>

  return (
    <div style={{ height: '100vh', display: 'grid', gridTemplateColumns: '240px 1fr 460px', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <aside style={{ borderRight: '1px solid #e5e7eb', padding: 14, background: '#f8fafc', overflow: 'auto' }}>
        <h2 style={{ marginTop: 0 }}>Builder</h2>
        {['http', 'noop', 'transform', 'condition', 'webhook', 'approval', 'ai', 'tool', 'agent'].map(type => <button key={type} onClick={() => addNode(type)} style={{ display: 'block', width: '100%', marginBottom: 6 }}>{type.toUpperCase()}</button>)}
        <hr />
        <button onClick={validate} style={{ width: '100%', marginBottom: 6 }}>Validate</button>
        <button onClick={save} style={{ width: '100%', marginBottom: 6 }}>Save</button>
        <button onClick={load} style={{ width: '100%', marginBottom: 6 }}>Load</button>
        <button onClick={start} style={{ width: '100%', marginBottom: 6 }}>Start</button>
        <button onClick={exportWorkflow} style={{ width: '100%', marginBottom: 6 }}>Export JSON</button>
        <button onClick={() => fileInputRef.current?.click()} style={{ width: '100%', marginBottom: 6 }}>Import JSON</button>
        <input ref={fileInputRef} type="file" accept="application/json" style={{ display: 'none' }} onChange={e => e.target.files?.[0] && importWorkflow(e.target.files[0])} />
        <p style={{ fontSize: 12, color: '#475569' }}>{saveInfo}</p>
        <p style={{ fontSize: 12, color: streamStatus === 'connected' ? '#16a34a' : '#64748b' }}>Stream: {streamStatus}</p>
        <hr />
        <h3>Experience</h3>
        {tabButton('copilot', '✨ AI Copilot')}
        {tabButton('marketplace', '🧩 Marketplace')}
        {tabButton('templates', '📦 Templates')}
        {tabButton('credentials', '🔐 Credentials')}
        {tabButton('inspector', '🔎 Data Inspector')}
        {tabButton('runs', '📊 Runs + Usage')}
        {tabButton('reasoning', '🧠 Reasoning')}
      </aside>

      <main style={{ height: '100vh' }}>
        <ReactFlow nodes={visibleNodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onNodeClick={(_, node) => { setSelectedNodeId(node.id); setSelectedEdgeId(null) }} onEdgeClick={(_, edge) => { setSelectedEdgeId(edge.id); setSelectedNodeId(null) }} onConnect={(params) => setEdges(eds => addEdge({ ...params, data: {} }, eds))}>
          <Background />
          <Controls />
        </ReactFlow>
      </main>

      <aside style={{ borderLeft: '1px solid #e5e7eb', padding: 16, overflow: 'auto', background: '#f8fafc' }}>
        {activeTab === 'copilot' && <section>
          <h2>AI Copilot</h2>
          <textarea value={copilotPrompt} onChange={e => setCopilotPrompt(e.target.value)} style={{ width: '100%', minHeight: 100 }} />
          <button onClick={runCopilot} style={{ width: '100%', marginTop: 8 }}>Generate workflow</button>
          <button onClick={explainWorkflow} style={{ width: '100%', marginTop: 8 }}>Explain current workflow</button>
        </section>}

        {activeTab === 'marketplace' && <section>
          <h2>Tool Marketplace</h2>
          {tools.map(tool => <div key={tool.name} style={{ padding: 10, background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 8 }}>
            <strong>{tool.name}</strong>
            <p style={{ fontSize: 12 }}>{tool.description}</p>
            <div style={{ fontSize: 11, color: '#64748b' }}>Required: {(tool.required ?? []).join(', ') || 'none'}</div>
            <button onClick={() => installPlugin(tool.name)} style={{ marginTop: 8 }}>Install</button>
          </div>)}
        </section>}

        {activeTab === 'templates' && <section>
          <h2>Templates</h2>
          {templates.map(t => <div key={t.id} style={{ padding: 10, background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 8 }}>
            <strong>{t.name}</strong>
            <p style={{ fontSize: 12 }}>{t.description}</p>
            <small>{t.category}</small><br />
            <button onClick={() => hydrateWorkflow(t.workflow)} style={{ marginTop: 8 }}>Use template</button>
          </div>)}
        </section>}

        {activeTab === 'credentials' && <section>
          <h2>Credentials</h2>
          <button onClick={createCredential}>New credential</button>
          {credentials.map(c => <div key={c.id} style={{ padding: 10, background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, marginTop: 8 }}>
            <strong>{c.name}</strong>
            <div style={{ fontSize: 12 }}>{c.kind} · {'{{secret.' + c.secretRef + '}}'}</div>
          </div>)}
        </section>}

        {activeTab === 'inspector' && <section>
          <h2>Data Inspector</h2>
          {selectedNode && selectedData ? <>
            <h3>Selected node</h3>
            <pre style={{ fontSize: 11, background: 'white', padding: 10, borderRadius: 10 }}>{JSON.stringify({ id: selectedNode.id, type: selectedData.type, config: selectedData.config }, null, 2)}</pre>
            <h3>Runtime data</h3>
            <pre style={{ fontSize: 11, background: 'white', padding: 10, borderRadius: 10 }}>{JSON.stringify(selectedRunNode ?? {}, null, 2)}</pre>
            <h3>Inspector</h3>
            <select value={selectedData.type} onChange={e => updateSelectedType(e.target.value)} style={{ width: '100%', marginBottom: 8 }}>{Object.keys(nodePresets).map(type => <option key={type} value={type}>{type.toUpperCase()}</option>)}</select>
            {selectedData.type === 'tool' && <select value={String((selectedData.config as any).tool ?? '')} onChange={e => updateSelectedConfigObject({ ...selectedData.config, tool: e.target.value, input: tools.find(t => t.name === e.target.value)?.inputExample ?? {} })} style={{ width: '100%', marginBottom: 8 }}><option value="">Select tool</option>{tools.map(tool => <option key={tool.name} value={tool.name}>{tool.name}</option>)}</select>}
            {selectedToolSchema && <p style={{ fontSize: 12 }}>{selectedToolSchema.description}</p>}
            <textarea key={selectedNodeId + JSON.stringify(selectedData.config)} defaultValue={JSON.stringify(selectedData.config, null, 2)} onBlur={e => { try { updateSelectedConfigObject(JSON.parse(e.target.value)) } catch {} }} style={{ width: '100%', minHeight: 160, fontFamily: 'monospace' }} />
          </> : selectedEdge ? <>
            <h3>Selected edge</h3>
            <p>{selectedEdge.source} → {selectedEdge.target}</p>
            <textarea defaultValue={selectedEdgeData?.condition ?? ''} onBlur={e => setEdges(current => current.map(edge => edge.id === selectedEdgeId ? { ...edge, label: e.target.value ? 'condition' : undefined, animated: Boolean(e.target.value), data: { ...(edge.data ?? {}), condition: e.target.value || undefined } } : edge))} placeholder="context.1.output.statusCode === 200" style={{ width: '100%', minHeight: 90 }} />
          </> : <p>Select a node or edge.</p>}
        </section>}

        {activeTab === 'runs' && <section>
          <h2>Runs + Usage</h2>
          <pre style={{ fontSize: 11, background: 'white', padding: 10, borderRadius: 10 }}>{JSON.stringify(usage, null, 2)}</pre>
          <button onClick={refreshPlatform}>Refresh</button>
          {runs.map(run => <div key={run.id} onClick={() => openRun(run.id)} style={{ cursor: 'pointer', padding: 10, background: runId === run.id ? '#e0f2fe' : 'white', border: '1px solid #e5e7eb', borderRadius: 10, marginTop: 8 }}>
            <strong>{run.id.slice(0, 8)}</strong><div>{run.status}</div>
          </div>)}
        </section>}

        {activeTab === 'reasoning' && <section>
          <h2>Agent Reasoning</h2>
          {!reasoningMessages.length && <p>Agent/tool trace will appear here during execution.</p>}
          {reasoningMessages.map(message => <div key={message.id} style={{ ...messageStyles[message.tone], borderRadius: 14, padding: 12, marginBottom: 10 }}>
            <strong>{message.title}</strong><p style={{ margin: '6px 0', color: '#334155' }}>{message.body}</p>{message.meta && <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', background: '#f8fafc', padding: 8, borderRadius: 8 }}>{message.meta}</pre>}
          </div>)}
          <h3>Replay</h3>
          <button disabled={!status.events.length || replayIndex === 0} onClick={() => setReplayIndex(i => Math.max((i ?? 0) - 1, 0))}>Prev</button>{' '}
          <button disabled={!status.events.length || replayIndex === status.events.length - 1} onClick={() => setReplayIndex(i => Math.min((i ?? -1) + 1, status.events.length - 1))}>Next</button>{' '}
          <button disabled={!status.events.length} onClick={() => setReplayIndex(status.events.length - 1)}>Live</button>
          {replayState?.currentEvent && <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', background: 'white', padding: 10, borderRadius: 10 }}>{JSON.stringify(replayState.currentEvent, null, 2)}</pre>}
          <h3>Waiting nodes</h3>
          {status.nodes.filter(n => n.status === 'waiting').map(n => <button key={n.nodeId} onClick={() => approveNode(n.nodeId)}>Approve {n.nodeId}</button>)}
        </section>}

        <hr />
        <h3>Validation</h3>
        {!validationIssues.length && <p style={{ color: '#16a34a' }}>No validation issues.</p>}
        {validationIssues.map((issue, i) => <div key={i} style={{ padding: 8, marginBottom: 8, background: '#fff1f2', border: '1px solid #fecdd3', borderRadius: 8 }}><strong>{issue.code}</strong><div>{issue.message}</div></div>)}
      </aside>
    </div>
  )
}

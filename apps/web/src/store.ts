import { create } from 'zustand'
import type { Edge, Node, OnEdgesChange, OnNodesChange } from '@xyflow/react'
import { applyEdgeChanges, applyNodeChanges, addEdge } from '@xyflow/react'
import type { Session, User } from '@supabase/supabase-js'
import { RunEvent, RunNode, ActiveTab } from './types'
import { nodePresets } from './constants'

type StreamStatus = 'idle' | 'connecting' | 'connected' | 'closed' | 'error'

type WorkflowStore = {
  // Auth
  session: Session | null
  user: User | null
  userId: string | null
  orgId: string | null
  authReady: boolean

  // Workflow editor
  nodes: Node[]
  edges: Edge[]
  selectedNodeId: string | null
  selectedEdgeId: string | null

  // Runtime
  runId: string | null
  runNodes: RunNode[]
  events: RunEvent[]
  activeTab: ActiveTab
  streamStatus: StreamStatus

  // Auth actions
  setAuth: (payload: { session: Session | null; user: User | null; userId: string | null; orgId: string | null }) => void
  clearAuth: () => void
  setAuthReady: (ready: boolean) => void

  // Editor actions
  addNode: (type: string) => void
  setNodes: (nodes: Node[]) => void
  setEdges: (edges: Edge[]) => void
  onNodesChange: OnNodesChange
  onEdgesChange: OnEdgesChange
  connect: (connection: any) => void
  selectNode: (id: string | null) => void
  selectEdge: (id: string | null) => void
  updateSelectedNodeConfig: (config: Record<string, any>) => void
  updateSelectedNodeType: (type: string) => void

  // Runtime actions
  setRunId: (id: string | null) => void
  setRunNodes: (nodes: RunNode[]) => void
  addEvents: (events: RunEvent[]) => void
  setEvents: (events: RunEvent[]) => void
  setActiveTab: (tab: ActiveTab) => void
  setStreamStatus: (status: StreamStatus) => void
  resetRun: () => void
}

const initialNodes: Node[] = [
  { id: '1', position: { x: 0, y: 0 }, data: { label: 'HTTP', type: 'http', config: { url: 'https://api.github.com' } } },
  { id: '2', position: { x: 260, y: 90 }, data: { label: 'MULTI_AGENT', type: 'multi_agent', config: nodePresets.multi_agent } },
]

const initialEdges: Edge[] = [{ id: 'e1-2', source: '1', target: '2', data: {} }]

export const useWorkflowStore = create<WorkflowStore>((set, get) => ({
  session: null,
  user: null,
  userId: null,
  orgId: null,
  authReady: false,

  nodes: initialNodes,
  edges: initialEdges,
  selectedNodeId: null,
  selectedEdgeId: null,
  runId: null,
  runNodes: [],
  events: [],
  activeTab: 'crew',
  streamStatus: 'idle',

  setAuth: ({ session, user, userId, orgId }) => set({ session, user, userId, orgId, authReady: true }),
  clearAuth: () => set({ session: null, user: null, userId: null, orgId: null, authReady: true }),
  setAuthReady: (authReady) => set({ authReady }),

  addNode: (type) => {
    const id = crypto.randomUUID().slice(0, 8)
    set((state) => ({
      nodes: state.nodes.concat({
        id,
        position: { x: 120 + state.nodes.length * 80, y: 120 + state.nodes.length * 40 },
        data: { label: type.toUpperCase(), type, config: nodePresets[type] ?? {} },
      })
    }))
  },

  setNodes: (nodes) => set({ nodes }),
  setEdges: (edges) => set({ edges }),
  onNodesChange: (changes) => set((state) => ({ nodes: applyNodeChanges(changes, state.nodes) })),
  onEdgesChange: (changes) => set((state) => ({ edges: applyEdgeChanges(changes, state.edges) })),
  connect: (connection) => set((state) => ({ edges: addEdge({ ...connection, data: {} }, state.edges) })),

  selectNode: (id) => set({ selectedNodeId: id, selectedEdgeId: null }),
  selectEdge: (id) => set({ selectedEdgeId: id, selectedNodeId: null }),

  updateSelectedNodeConfig: (config) => {
    const selectedNodeId = get().selectedNodeId
    if (!selectedNodeId) return
    set((state) => ({
      nodes: state.nodes.map((node) => node.id === selectedNodeId ? { ...node, data: { ...node.data, config } } : node)
    }))
  },

  updateSelectedNodeType: (type) => {
    const selectedNodeId = get().selectedNodeId
    if (!selectedNodeId) return
    set((state) => ({
      nodes: state.nodes.map((node) => node.id === selectedNodeId
        ? { ...node, data: { label: type.toUpperCase(), type, config: nodePresets[type] ?? {} } }
        : node)
    }))
  },

  setRunId: (id) => set({ runId: id }),
  setRunNodes: (nodes) => set({ runNodes: nodes }),
  setEvents: (events) => set({ events }),

  addEvents: (incoming) => set((state) => {
    const seen = new Set(state.events.map((e) => e.id ?? `${e.type}:${e.nodeId}:${e.createdAt}`))
    const merged = [...state.events]
    for (const event of incoming) {
      const key = event.id ?? `${event.type}:${event.nodeId}:${event.createdAt}`
      if (!seen.has(key)) {
        seen.add(key)
        merged.push(event)
      }
    }
    return { events: merged }
  }),

  setActiveTab: (tab) => set({ activeTab: tab }),
  setStreamStatus: (streamStatus) => set({ streamStatus }),
  resetRun: () => set({ runId: null, runNodes: [], events: [], streamStatus: 'idle' }),
}))

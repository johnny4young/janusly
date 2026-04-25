import { create } from 'zustand'
import { RunEvent, RunNode } from './types'

type Store = {
  runId: string | null
  events: RunEvent[]
  nodes: RunNode[]
  setRunId: (id: string | null) => void
  addEvents: (events: RunEvent[]) => void
  setNodes: (nodes: RunNode[]) => void
  reset: () => void
}

export const useWorkflowStore = create<Store>((set) => ({
  runId: null,
  events: [],
  nodes: [],

  setRunId: (id) => set({ runId: id }),

  addEvents: (incoming) =>
    set((state) => {
      const seen = new Set(state.events.map((e) => e.id))
      const merged = [...state.events]

      for (const e of incoming) {
        if (!seen.has(e.id)) merged.push(e)
      }

      return { events: merged }
    }),

  setNodes: (nodes) => set({ nodes }),

  reset: () => set({ runId: null, events: [], nodes: [] }),
}))

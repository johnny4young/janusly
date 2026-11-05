import { create } from 'zustand'

/** A step's stand-in output for draft test runs. Never part of the workflow document. */
export type TestDatum =
  | { kind: 'pinned'; sourceRunId: string; output: unknown }
  | { kind: 'mocked'; output: unknown }

type TestDataState = {
  workflowId: string
  pins: Record<string, TestDatum>
  setDatum: (workflowId: string, nodeId: string, datum: TestDatum | null) => void
}

// In memory only: a reload or another workflow starts without stand-ins.
export const useTestData = create<TestDataState>(set => ({
  workflowId: '',
  pins: {},
  setDatum: (workflowId, nodeId, datum) => set(state => {
    const pins = state.workflowId === workflowId ? { ...state.pins } : {}
    if (datum) pins[nodeId] = datum
    else delete pins[nodeId]
    return { workflowId, pins }
  }),
}))

export function testDataFor(workflowId: string): Record<string, TestDatum> {
  const state = useTestData.getState()
  return state.workflowId === workflowId ? state.pins : {}
}

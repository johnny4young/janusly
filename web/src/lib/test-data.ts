import { create } from 'zustand'
import { getActiveOrg } from '../auth'

/** A step's stand-in output for draft test runs. Never part of the workflow document. */
export type TestDatum =
  | { kind: 'pinned'; sourceRunId: string; output: unknown }
  | { kind: 'mocked'; output: unknown }

type TestDataState = {
  scope: string
  pins: Record<string, TestDatum>
  setDatum: (workflowId: string, nodeId: string, datum: TestDatum | null) => void
}

const scopeOf = (workflowId: string) => `${getActiveOrg()}\n${workflowId}`

// In memory only: a reload, another workflow or another workspace starts empty.
export const useTestData = create<TestDataState>(set => ({
  scope: '',
  pins: {},
  setDatum: (workflowId, nodeId, datum) => set(state => {
    const scope = scopeOf(workflowId)
    const pins = state.scope === scope ? { ...state.pins } : {}
    if (datum) pins[nodeId] = datum
    else delete pins[nodeId]
    return { scope, pins }
  }),
}))

export function useTestDataPins(workflowId: string): Record<string, TestDatum> | undefined {
  return useTestData(state => state.scope === scopeOf(workflowId) ? state.pins : undefined)
}

export function testDataFor(workflowId: string): Record<string, TestDatum> {
  const state = useTestData.getState()
  return state.scope === scopeOf(workflowId) ? state.pins : {}
}

export function clearTestData(): void {
  useTestData.setState({ scope: '', pins: {} })
}

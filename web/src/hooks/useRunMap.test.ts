import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import type { RunMap } from '../run-map'
import { useWorkflowStore } from '../store'
import { RUN_MAP_SETTLE_MS, RUN_MAP_TICK_MS, refreshRunMap, useRunMap } from './useRunMap'

vi.mock('../api', async () => {
  const { contractApiOver } = await import('../test/contract-api-mock')
  const api = vi.fn()
  return { api, contractApi: contractApiOver(api) }
})

function runMap(runId: string, status: RunMap['run']['status'] = 'running'): RunMap {
  return {
    run: { id: runId, status, workflowVersionId: 'v1', parentRunId: null },
    nodes: [],
    lanes: [],
    totals: { costUsd: 0.5, tokens: 10 },
  }
}

const mapCalls = () => vi.mocked(api).mock.calls.filter(([path]) => String(path).endsWith('/map')).length

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(api).mockReset()
  useWorkflowStore.setState({ runId: 'run-1', events: [], runNodes: [] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useRunMap', () => {
  it('shares one feed between views and reads the versioned route through the guard', async () => {
    vi.mocked(api).mockResolvedValue(runMap('run-1'))
    const first = renderHook(() => useRunMap('run-1'))
    const second = renderHook(() => useRunMap('run-1'))
    await flush()
    expect(mapCalls()).toBe(1)
    expect(vi.mocked(api).mock.calls[0]![0]).toBe('/v1/runs/run-1/map')
    expect(first.result.current?.map.totals.costUsd).toBe(0.5)
    expect(second.result.current).toBe(first.result.current)
    first.unmount()
    second.unmount()
  })

  it('refetches once, settled, after stream frames land', async () => {
    vi.mocked(api).mockResolvedValue(runMap('run-1'))
    const view = renderHook(() => useRunMap('run-1'))
    await flush()
    act(() => {
      useWorkflowStore.setState({ events: [{ id: 'e1', type: 'node.started' }] })
      useWorkflowStore.setState({ events: [{ id: 'e1', type: 'node.started' }, { id: 'e2', type: 'agent.step.started' }] })
      useWorkflowStore.setState({ runNodes: [{ nodeId: 'a', status: 'running' }] })
    })
    await act(async () => { vi.advanceTimersByTime(RUN_MAP_SETTLE_MS - 1) })
    expect(mapCalls()).toBe(1)
    await act(async () => { vi.advanceTimersByTime(1) })
    await flush()
    expect(mapCalls()).toBe(2)
    act(() => useWorkflowStore.setState({ runId: 'other', events: [] }))
    await act(async () => { vi.advanceTimersByTime(RUN_MAP_SETTLE_MS) })
    expect(mapCalls()).toBe(2)
    view.unmount()
  })

  it('ticks while the run is open and stops once it is terminal', async () => {
    vi.mocked(api).mockResolvedValue(runMap('run-1'))
    const view = renderHook(() => useRunMap('run-1'))
    await flush()
    await act(async () => { vi.advanceTimersByTime(RUN_MAP_TICK_MS) })
    await flush()
    expect(mapCalls()).toBe(2)
    vi.mocked(api).mockResolvedValue(runMap('run-1', 'succeeded'))
    await act(async () => { vi.advanceTimersByTime(RUN_MAP_TICK_MS) })
    await flush()
    expect(mapCalls()).toBe(3)
    expect(view.result.current?.map.run.status).toBe('succeeded')
    await act(async () => { vi.advanceTimersByTime(RUN_MAP_TICK_MS * 3) })
    expect(mapCalls()).toBe(3)
    view.unmount()
  })

  it('never polls a finished run', async () => {
    vi.mocked(api).mockResolvedValue(runMap('done', 'failed'))
    const view = renderHook(() => useRunMap('done'))
    await flush()
    await act(async () => { vi.advanceTimersByTime(RUN_MAP_TICK_MS * 2) })
    expect(mapCalls()).toBe(1)
    view.unmount()
  })

  it('coalesces a refresh asked while a read is in flight, and keeps the last map on failure', async () => {
    let release: (value: RunMap) => void = () => undefined
    vi.mocked(api).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const view = renderHook(() => useRunMap('run-1'))
    refreshRunMap('run-1')
    refreshRunMap('run-1')
    expect(mapCalls()).toBe(1)
    vi.mocked(api).mockRejectedValueOnce(new Error('offline'))
    await act(async () => { release(runMap('run-1')) })
    await flush()
    expect(mapCalls()).toBe(2)
    expect(view.result.current?.map.run.id).toBe('run-1')
    view.unmount()
  })

  it('stops reading once the last view leaves', async () => {
    vi.mocked(api).mockResolvedValue(runMap('run-1'))
    const view = renderHook(() => useRunMap('run-1'))
    await flush()
    view.unmount()
    await act(async () => { vi.advanceTimersByTime(RUN_MAP_TICK_MS * 2) })
    act(() => useWorkflowStore.setState({ events: [{ id: 'late', type: 'node.started' }] }))
    await act(async () => { vi.advanceTimersByTime(RUN_MAP_SETTLE_MS) })
    expect(mapCalls()).toBe(1)
  })

  it('reads nothing without a run', () => {
    const view = renderHook(() => useRunMap(null))
    expect(view.result.current).toBeNull()
    expect(mapCalls()).toBe(0)
    view.unmount()
  })
})

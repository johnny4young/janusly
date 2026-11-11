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

describe('run map identity isolation', () => {
  const identity = (userId: string, orgId: string) => {
    useWorkflowStore.getState().setAuth({ session: null, user: null, userId, orgId })
  }

  it.each([
    ['workspace', 'user-a', 'org-b'],
    ['user', 'user-b', 'org-a'],
  ])('discards the cached map when the %s changes', async (_change, userId, orgId) => {
    act(() => identity('user-a', 'org-a'))
    vi.mocked(api).mockResolvedValue(runMap('private-run', 'succeeded'))
    const first = renderHook(() => useRunMap('private-run'))
    await flush()
    expect(first.result.current?.map.run.id).toBe('private-run')
    first.unmount()

    act(() => identity(userId, orgId))
    vi.mocked(api).mockRejectedValue(new Error('run not found'))
    const second = renderHook(() => useRunMap('private-run'))
    expect(second.result.current).toBeNull()
    await flush()
    expect(second.result.current).toBeNull()
    second.unmount()
  })

  it('ignores an old response and restarts the mounted feed under the new identity', async () => {
    act(() => identity('user-a', 'org-a'))
    let release: (value: RunMap) => void = () => undefined
    vi.mocked(api).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const view = renderHook(() => useRunMap('late-private-run'))
    const oldSignal = vi.mocked(api).mock.calls[0]![1]!.signal
    vi.mocked(api).mockRejectedValue(new Error('run not found'))
    act(() => identity('user-a', 'org-b'))
    expect(oldSignal?.aborted).toBe(true)
    expect(mapCalls()).toBe(2)
    await act(async () => { release(runMap('late-private-run')) })
    await flush()
    view.rerender()
    expect(view.result.current).toBeNull()
    const later = renderHook(() => useRunMap('late-private-run'))
    expect(later.result.current).toBeNull()
    later.unmount()
    view.unmount()
  })

  it('does not refetch a retired feed when a queued reload finishes', async () => {
    act(() => identity('user-a', 'org-a'))
    let release: (value: RunMap) => void = () => undefined
    vi.mocked(api).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const view = renderHook(() => useRunMap('queued-run'))
    refreshRunMap('queued-run')
    vi.mocked(api).mockImplementation(() => new Promise(() => undefined))
    act(() => identity('user-a', 'org-b'))
    const calls = mapCalls()
    await act(async () => { release(runMap('queued-run')) })
    await flush()
    expect(mapCalls()).toBe(calls)
    view.unmount()
  })

  it('clears a cached map on sign-out even when the same identity signs in again', async () => {
    act(() => identity('user-a', 'org-a'))
    vi.mocked(api).mockResolvedValue(runMap('signed-out-run', 'succeeded'))
    const first = renderHook(() => useRunMap('signed-out-run'))
    await flush()
    first.unmount()
    act(() => useWorkflowStore.getState().clearAuth())
    act(() => identity('user-a', 'org-a'))
    vi.mocked(api).mockRejectedValue(new Error('run not found'))
    const next = renderHook(() => useRunMap('signed-out-run'))
    expect(next.result.current).toBeNull()
    await flush()
    expect(next.result.current).toBeNull()
    next.unmount()
  })

  it('retires mounted snapshots and keeps the replacement feed polling', async () => {
    act(() => identity('user-a', 'org-a'))
    vi.mocked(api).mockResolvedValue(runMap('mounted-run'))
    const first = renderHook(() => useRunMap('mounted-run'))
    const second = renderHook(() => useRunMap('mounted-run'))
    await flush()
    vi.mocked(api).mockRejectedValue(new Error('run not found'))
    act(() => identity('user-a', 'org-b'))
    expect(first.result.current).toBeNull()
    expect(second.result.current).toBeNull()
    await flush()
    expect(mapCalls()).toBe(2)
    first.unmount()
    await act(async () => { vi.advanceTimersByTime(RUN_MAP_TICK_MS) })
    await flush()
    expect(mapCalls()).toBe(3)
    second.unmount()
  })

  it('does not reset a feed when the same identity is refreshed', async () => {
    act(() => identity('user-a', 'org-a'))
    vi.mocked(api).mockResolvedValue(runMap('same-identity'))
    const view = renderHook(() => useRunMap('same-identity'))
    await flush()
    const snapshot = view.result.current
    act(() => identity('user-a', 'org-a'))
    expect(view.result.current).toBe(snapshot)
    expect(mapCalls()).toBe(1)
    view.unmount()
  })
})

import { useEffect } from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import { useRunPolling } from './useRunPolling'
import type { RunSummaryUpdateStarter } from './useBootstrapData'

vi.mock('../api', () => {
  const module = ({ api: vi.fn() })
  return {
    ...module,
    // Typed reads route through contractApi; delegate to the same mock so the
    // path-keyed expectations below keep working.
    // The response guard is not a fetch option.
    contractApi: (_operation: string, path: string, _request: unknown, options?: RequestInit & { guard?: unknown }) => {
      const { guard: _guard, ...init } = options ?? {}
      return Object.keys(init).length === 0 ? module.api(path) : module.api(path, init)
    },
  }
})

function statusResponse(value: unknown) {
  return { nodes: [], events: [], eventsCursor: null, eventsHasMore: false, ...value as Record<string, unknown> }
}

function Harness({
  runId,
  onTerminal = vi.fn(),
  captureLoadStatus,
  beginRunSummaryUpdate = () => () => true,
}: {
  runId: string | null
  onTerminal?: () => void
  captureLoadStatus?: (loadStatus: (id: string) => Promise<unknown>) => void
  beginRunSummaryUpdate?: RunSummaryUpdateStarter
}) {
  const { loadStatus } = useRunPolling(runId, onTerminal, beginRunSummaryUpdate)
  useEffect(() => {
    captureLoadStatus?.(loadStatus)
  }, [captureLoadStatus, loadStatus])
  return null
}

beforeEach(() => {
  vi.mocked(api).mockReset()
  useWorkflowStore.getState().resetRun()
})

afterEach(() => cleanup())

describe('useRunPolling request ownership', () => {
  it('drops a late status response after the operator switches runs', async () => {
    const onTerminal = vi.fn()
    let resolveStatus!: (value: unknown) => void
    vi.mocked(api).mockImplementation(() => new Promise(resolve => { resolveStatus = value => resolve(statusResponse(value)) }))
    useWorkflowStore.setState({ runId: 'run-a' })

    render(<Harness runId="run-a" onTerminal={onTerminal} />)
    await waitFor(() => expect(api).toHaveBeenCalledWith('/status?runId=run-a'))

    useWorkflowStore.setState({
      runId: 'run-b',
      runNodes: [{ nodeId: 'node-b', status: 'running' }],
      events: [{ id: 'event-b', type: 'node.running', nodeId: 'node-b' }],
    })
    await act(async () => {
      resolveStatus({
        run: { id: 'run-a', status: 'failed' },
        nodes: [{ nodeId: 'node-a', status: 'failed' }],
        events: [{ id: 'event-a', type: 'node.failed', nodeId: 'node-a' }],
      })
    })

    expect(useWorkflowStore.getState().runNodes).toEqual([{ nodeId: 'node-b', status: 'running' }])
    expect(useWorkflowStore.getState().events).toEqual([{ id: 'event-b', type: 'node.running', nodeId: 'node-b' }])
    expect(onTerminal).not.toHaveBeenCalled()
  })

  it('drops a same-id terminal response after the ownership generation changes', async () => {
    const onTerminal = vi.fn()
    let resolveStatus!: (value: unknown) => void
    vi.mocked(api).mockImplementation(() => new Promise(resolve => { resolveStatus = value => resolve(statusResponse(value)) }))
    useWorkflowStore.setState({ runId: 'run-a' })

    render(<Harness runId="run-a" onTerminal={onTerminal} />)
    await waitFor(() => expect(api).toHaveBeenCalledWith('/status?runId=run-a'))

    useWorkflowStore.setState(state => ({
      runId: 'run-a',
      runTransitionGeneration: state.runTransitionGeneration + 1,
      runNodes: [{ nodeId: 'current', status: 'running' }],
    }))
    await act(async () => {
      resolveStatus({
        run: { id: 'run-a', status: 'succeeded' },
        nodes: [{ nodeId: 'stale', status: 'succeeded' }],
      })
    })

    expect(useWorkflowStore.getState().runNodes).toEqual([{ nodeId: 'current', status: 'running' }])
    expect(onTerminal).not.toHaveBeenCalled()
  })

  it('suppresses a stale request failure after the ownership generation changes', async () => {
    let rejectStatus!: (reason: unknown) => void
    vi.mocked(api).mockImplementation(() => new Promise((_, reject) => { rejectStatus = reject }))
    useWorkflowStore.setState({ runId: 'run-a' })

    render(<Harness runId="run-a" />)
    await waitFor(() => expect(api).toHaveBeenCalledWith('/status?runId=run-a'))

    useWorkflowStore.setState(state => ({
      runTransitionGeneration: state.runTransitionGeneration + 1,
    }))
    await act(async () => {
      rejectStatus(new Error('stale failure'))
    })

    expect(useWorkflowStore.getState().streamStatus).not.toBe('error')
    expect(useWorkflowStore.getState().toasts).toEqual([])
  })

  it('serializes interval ticks while a status request is in flight', async () => {
    vi.useFakeTimers()
    try {
      let resolveStatus!: (value: unknown) => void
      vi.mocked(api).mockImplementation(() => new Promise(resolve => { resolveStatus = value => resolve(statusResponse(value)) }))
      useWorkflowStore.setState({ runId: 'run-a' })

      render(<Harness runId="run-a" />)
      await act(async () => undefined)
      expect(api).toHaveBeenCalledTimes(1)

      await act(async () => { vi.advanceTimersByTime(4_500) })
      expect(api).toHaveBeenCalledTimes(1)

      await act(async () => {
        resolveStatus({ run: { id: 'run-a', status: 'running' } })
      })
      await act(async () => { vi.advanceTimersByTime(1_500) })
      expect(api).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the newest status response when a manual refresh overlaps polling', async () => {
    const resolvers: Array<(value: unknown) => void> = []
    vi.mocked(api).mockImplementation(() => new Promise(resolve => { resolvers.push(value => resolve(statusResponse(value))) }))
    useWorkflowStore.setState({ runId: 'run-a' })
    let loadStatus!: (id: string) => Promise<unknown>

    render(<Harness runId="run-a" captureLoadStatus={(load) => { loadStatus = load }} />)
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(loadStatus).toBeTypeOf('function'))

    let manualRequest!: Promise<unknown>
    act(() => {
      manualRequest = loadStatus('run-a')
    })
    expect(api).toHaveBeenCalledTimes(2)

    await act(async () => {
      resolvers[1]({
        run: { id: 'run-a', status: 'succeeded' },
        nodes: [{ nodeId: 'node-a', status: 'succeeded' }],
      })
      await manualRequest
    })
    await act(async () => {
      resolvers[0]({
        run: { id: 'run-a', status: 'running' },
        nodes: [{ nodeId: 'node-a', status: 'running' }],
      })
    })

    expect(useWorkflowStore.getState().runNodes).toEqual([{ nodeId: 'node-a', status: 'succeeded' }])
  })

  it('reserves summary ownership before awaiting the status response', async () => {
    let resolveStatus!: (value: unknown) => void
    vi.mocked(api).mockImplementation(() => new Promise(resolve => { resolveStatus = value => resolve(statusResponse(value)) }))
    useWorkflowStore.setState({ runId: 'run-a' })
    const commit = vi.fn(() => true)
    const beginRunSummaryUpdate = vi.fn(() => commit)

    render(
      <Harness
        runId="run-a"
        beginRunSummaryUpdate={beginRunSummaryUpdate}
      />,
    )
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1))
    expect(beginRunSummaryUpdate).toHaveBeenCalledWith('run-a')

    await act(async () => {
      resolveStatus({ run: { id: 'run-a', status: 'running' } })
    })
    expect(commit).toHaveBeenCalledWith({ id: 'run-a', status: 'running' })
  })
})


describe('useRunPolling snapshot integrity', () => {
  it.each([{}, { run: { id: 'run-a', status: 'failed' }, nodes: [{}], events: [], eventsCursor: null, eventsHasMore: false }])('rejects a corrupt snapshot without overwriting the last valid projection: %j', async payload => {
    vi.mocked(api).mockResolvedValue(payload)
    const nodes = [{ nodeId: 'kept', status: 'running' }]
    const events = [{ id: 'kept-event', type: 'node.running' }]
    useWorkflowStore.setState({ runId: 'run-a', runNodes: nodes, events, eventsCursor: 'older', eventsHasMore: true })
    let loadStatus!: (id: string) => Promise<unknown>
    const commit = vi.fn(() => true)
    render(<Harness runId={null} captureLoadStatus={load => { loadStatus = load }} beginRunSummaryUpdate={() => commit} />)
    await act(async () => {
      await expect(loadStatus('run-a')).rejects.toThrow('unreadable response')
    })
    expect(useWorkflowStore.getState().runNodes).toEqual(nodes)
    expect(useWorkflowStore.getState().events).toEqual(events)
    expect(useWorkflowStore.getState().eventsCursor).toBe('older')
    expect(useWorkflowStore.getState().eventsHasMore).toBe(true)
    expect(commit).not.toHaveBeenCalled()
  })
})


it('preserves an older history cursor when the latest page still has more events', async () => {
  const latest = { id: 'latest', type: 'node.running' }
  useWorkflowStore.setState({ runId: 'run-a', events: [{ id: 'older', type: 'node.queued' }, latest], eventsCursor: 'older-cursor', eventsHasMore: true })
  vi.mocked(api).mockResolvedValue({ run: { id: 'run-a', status: 'running' }, nodes: [], events: [latest], eventsCursor: 'latest-cursor', eventsHasMore: true })
  let loadStatus!: (id: string) => Promise<unknown>
  render(<Harness runId={null} captureLoadStatus={load => { loadStatus = load }} />)
  await act(async () => { await loadStatus('run-a') })
  expect(useWorkflowStore.getState().events).toHaveLength(2)
  expect(useWorkflowStore.getState().eventsCursor).toBe('older-cursor')
})

it('stops polling and signals terminal completion only after a valid terminal snapshot', async () => {
  vi.useFakeTimers()
  try {
    const terminal = vi.fn()
    useWorkflowStore.setState({ runId: 'run-a' })
    vi.mocked(api).mockResolvedValue(statusResponse({ run: { id: 'run-a', status: 'succeeded' } }))
    render(<Harness runId="run-a" onTerminal={terminal} />)
    await act(async () => undefined)
    await act(async () => { vi.advanceTimersByTime(4500) })
    expect(terminal).toHaveBeenCalledOnce()
    expect(api).toHaveBeenCalledOnce()
  } finally { vi.useRealTimers() }
})

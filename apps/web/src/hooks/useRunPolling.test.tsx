import { useEffect } from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import { useRunPolling } from './useRunPolling'

vi.mock('../api', () => ({ api: vi.fn() }))

function Harness({
  runId,
  onTerminal = vi.fn(),
  captureLoadStatus,
}: {
  runId: string | null
  onTerminal?: () => void
  captureLoadStatus?: (loadStatus: (id: string) => Promise<unknown>) => void
}) {
  const { loadStatus } = useRunPolling(runId, onTerminal, vi.fn())
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
    vi.mocked(api).mockImplementation(() => new Promise(resolve => { resolveStatus = resolve }))
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
    vi.mocked(api).mockImplementation(() => new Promise(resolve => { resolveStatus = resolve }))
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
      vi.mocked(api).mockImplementation(() => new Promise(resolve => { resolveStatus = resolve }))
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
    vi.mocked(api).mockImplementation(() => new Promise(resolve => { resolvers.push(resolve) }))
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
})

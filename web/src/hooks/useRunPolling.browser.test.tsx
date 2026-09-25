import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, __resetInFlightForTests } from '../api'
import { useWorkflowStore } from '../store'
import { useRunPolling } from './useRunPolling'

vi.mock('../auth', () => ({
  getSupabaseAccessToken: async () => null,
  getActiveOrg: () => 'default',
  hasBrowserSession: () => false,
  handleBrowserSessionExpired: vi.fn(),
}))

afterEach(() => {
  __resetInFlightForTests()
  vi.unstubAllGlobals()
  useWorkflowStore.getState().resetRun()
})

// The full wire snapshot: the generated /status guard rejects partial rows.
const snapshot = (status: string) => ({
  run: {
    id: 'browser-run', orgId: 'org', workflowVersionId: 'version', workflowRolloutId: null,
    workflowRolloutVariant: null, status, outcomeStatus: null, semanticViolationCount: 0,
    inputJson: null, outputJson: null, parentRunId: null, parentNodeId: null, parentLinkKind: null,
    parentNotificationAfter: null, recoveryPlaybookAppliedRecordedAt: null,
    recoveryPlaybookValidationRecordedAt: null, replayMode: null, traceId: null,
    validationEvidenceLevel: null, createdBy: null, createdAt: null,
  },
  nodes: [{
    id: 'node-row', runId: 'browser-run', nodeId: 'work', status, stateJson: null, errorJson: null,
    attempts: 1, startedAt: null, finishedAt: null,
  }],
  events: [], eventsCursor: null, eventsHasMore: false,
})

describe('status transport in Chromium', () => {
  it('keeps the last projection after a real body stream failure and recovers on retry', async () => {
    useWorkflowStore.setState({ runId: 'browser-run', runNodes: [{ nodeId: 'work', status: 'running' }] })
    const commit = vi.fn(() => true)
    const { result } = renderHook(() => useRunPolling(null, vi.fn(), () => commit))
    const brokenBody = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new TypeError('connection lost')) } })
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(brokenBody, { status: 200 }))
      .mockImplementation(async () => new Response(JSON.stringify(snapshot('succeeded')), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await act(async () => {
      await expect(result.current.loadStatus('browser-run')).rejects.toThrow('unreadable response')
    })
    expect(useWorkflowStore.getState().runNodes).toEqual([{ nodeId: 'work', status: 'running' }])
    expect(commit).not.toHaveBeenCalled()

    // The failed request's ordinary dedup TTL expires; a later poll succeeds.
    await vi.waitFor(async () => {
      await act(async () => { await result.current.loadStatus('browser-run') })
      expect(useWorkflowStore.getState().runNodes).toEqual([expect.objectContaining({ nodeId: 'work', status: 'succeeded' })])
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ id: 'browser-run', status: 'succeeded' }))
  })

  it('does not turn an aborted body stream into an empty success', async () => {
    const controller = new AbortController()
    let started!: () => void
    const reading = new Promise<void>(resolve => { started = resolve })
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_url, init) => new Response(new ReadableStream<Uint8Array>({
      start(body) {
        init?.signal?.addEventListener('abort', () => body.error(new DOMException('cancelled', 'AbortError')), { once: true })
        started()
      },
    }), { status: 200 })))
    const request = api('/status?runId=browser-run', { signal: controller.signal })
    const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    await reading
    controller.abort()
    await rejection
  })
})

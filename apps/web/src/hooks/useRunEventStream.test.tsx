import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'

import { useRunEventStream } from './useRunEventStream'
import type { RunSummaryPatcher } from './useRunPolling'
import { useWorkflowStore } from '../store'

const openRunEventStreamMock = vi.fn()
vi.mock('../api', () => ({
  openRunEventStream: (...args: unknown[]) => openRunEventStreamMock(...args),
}))

/**
 * Build a Response-like object whose body streams the given SSE chunks, then
 * stays OPEN (a real live stream doesn't close until terminal/disconnect — a
 * closing stream would correctly trip the hook's reconnect/fallback path and
 * race these assertions). The hook's unmount cleanup aborts it.
 */
function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  let i = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]))
        return
      }
      // Emitted everything — keep the stream open (never resolve).
      return new Promise<void>(() => {})
    },
  })
  return { ok: true, status: 200, body } as unknown as Response
}

function Harness({ runId, patchRunSummary }: { runId: string | null; patchRunSummary?: RunSummaryPatcher }) {
  useRunEventStream(runId, patchRunSummary)
  return <div />
}

const eventFrame = (id: string, createdAt: string) =>
  `id: ${createdAt}|${id}\nevent: run-event\ndata: ${JSON.stringify({ kind: 'event', id, nodeId: 'n1', type: 'node.succeeded', payload: { ok: true }, createdAt })}\n\n`

beforeEach(() => {
  openRunEventStreamMock.mockReset()
  useWorkflowStore.getState().resetRun()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('useRunEventStream', () => {
  it('parses SSE frames and merges events into the store, marking transport "sse"', async () => {
    openRunEventStreamMock.mockResolvedValue(
      streamResponse([
        ': connected\n\n',
        eventFrame('evt-1', '2026-05-28T00:00:00.000Z'),
        eventFrame('evt-2', '2026-05-28T00:00:01.000Z'),
      ]),
    )

    render(<Harness runId="run-1" />)

    await waitFor(() => {
      expect(useWorkflowStore.getState().streamTransport).toBe('sse')
    })
    await waitFor(() => {
      const ids = useWorkflowStore.getState().events.map((e) => e.id)
      expect(ids).toContain('evt-1')
      expect(ids).toContain('evt-2')
    })
  })

  it('materializes streamed waiting-node metadata while polling is paused', async () => {
    const createdAt = '2026-05-28T00:00:02.000Z'
    const payload = {
      status: 'waiting',
      reason: 'Waiting for form submission',
      metadata: {
        kind: 'human_form',
        title: 'Access review',
        schema: {
          type: 'object',
          properties: { requester: { type: 'string' } },
          required: ['requester'],
        },
        resumeToken: 'resume-token',
      },
    }
    openRunEventStreamMock.mockResolvedValue(
      streamResponse([
        ': connected\n\n',
        `id: ${createdAt}|evt-waiting\nevent: run-event\ndata: ${JSON.stringify({ kind: 'event', id: 'evt-waiting', nodeId: 'collect', type: 'node.waiting', payload, createdAt })}\n\n`,
      ]),
    )

    render(<Harness runId="run-1" />)

    await waitFor(() => {
      expect(useWorkflowStore.getState().streamTransport).toBe('sse')
    })
    await waitFor(() => {
      expect(useWorkflowStore.getState().runNodes).toContainEqual({
        nodeId: 'collect',
        status: 'waiting',
        stateJson: { waiting: payload.metadata },
      })
    })
  })

  it('patches a live approval escalation while healthy SSE has polling paused', async () => {
    const createdAt = '2026-05-28T00:00:03.000Z'
    const waiting = {
      kind: 'approval',
      assignee: 'tier-2',
      escalatedFrom: 'tier-1',
      timeoutState: 'escalated',
      deadlineAt: '2026-05-28T00:00:02.000Z',
    }
    useWorkflowStore.getState().setRunNodes([{
      nodeId: 'approval-gate',
      status: 'waiting',
      stateJson: { waiting: { ...waiting, assignee: 'tier-1', timeoutState: undefined } },
    }])
    openRunEventStreamMock.mockResolvedValue(
      streamResponse([
        ': connected\n\n',
        `id: ${createdAt}|evt-escalated\nevent: run-event\ndata: ${JSON.stringify({ kind: 'event', id: 'evt-escalated', nodeId: 'approval-gate', type: 'approval.escalated', payload: { assignee: 'tier-2', waiting }, createdAt })}\n\n`,
      ]),
    )

    render(<Harness runId="run-1" />)

    await waitFor(() => expect(useWorkflowStore.getState().streamTransport).toBe('sse'))
    await waitFor(() => {
      expect(useWorkflowStore.getState().runNodes[0]).toMatchObject({
        nodeId: 'approval-gate',
        status: 'waiting',
        stateJson: { waiting },
      })
    })
  })

  it('falls back to polling transport when the stream cannot open', async () => {
    openRunEventStreamMock.mockRejectedValue(new Error('blocked'))

    render(<Harness runId="run-1" />)

    await waitFor(() => {
      expect(useWorkflowStore.getState().streamTransport).toBe('polling')
    })
  })

  it('ignores a run.status signal that is not terminal and stays live', async () => {
    const patchRunSummary = vi.fn()
    openRunEventStreamMock.mockResolvedValue(
      streamResponse([
        ': connected\n\n',
        `event: run-status\ndata: ${JSON.stringify({ kind: 'run.status', status: 'running' })}\n\n`,
        eventFrame('evt-1', '2026-05-28T00:00:00.000Z'),
      ]),
    )

    render(<Harness runId="run-1" patchRunSummary={patchRunSummary} />)

    await waitFor(() => {
      expect(useWorkflowStore.getState().events.map((e) => e.id)).toContain('evt-1')
    })
    expect(useWorkflowStore.getState().streamTransport).toBe('sse')
    expect(patchRunSummary).toHaveBeenCalledWith('run-1', { status: 'running' })
  })

  it('hands back to polling but keeps consuming trailing events after a terminal status', async () => {
    const patchRunSummary = vi.fn()
    openRunEventStreamMock.mockResolvedValue(
      streamResponse([
        ': connected\n\n',
        `event: run-status\ndata: ${JSON.stringify({ kind: 'run.status', status: 'succeeded' })}\n\n`,
        eventFrame('evt-after-terminal', '2026-05-28T00:00:03.000Z'),
      ]),
    )

    render(<Harness runId="run-1" patchRunSummary={patchRunSummary} />)

    await waitFor(() => {
      expect(useWorkflowStore.getState().streamTransport).toBe('polling')
    })
    await waitFor(() => {
      expect(useWorkflowStore.getState().events.map(event => event.id)).toContain('evt-after-terminal')
    })
    expect(patchRunSummary).toHaveBeenCalledWith('run-1', { status: 'succeeded' })
    expect(openRunEventStreamMock).toHaveBeenCalledTimes(1)
  })

  it('lands a truncated catch-up page and reconnects immediately from its newest cursor', async () => {
    const createdAt = '2026-05-28T00:08:20.000Z'
    openRunEventStreamMock
      .mockResolvedValueOnce(streamResponse([
        ': connected\n\n',
        eventFrame('evt-500', createdAt),
        `event: catchup-truncated\ndata: ${JSON.stringify({ kind: 'catchup-truncated', replayed: 500 })}\n\n`,
      ]))
      .mockResolvedValueOnce(streamResponse([
        ': connected\n\n',
        `event: run-status\ndata: ${JSON.stringify({ kind: 'run.status', status: 'running' })}\n\n`,
        eventFrame('evt-501', '2026-05-28T00:08:21.000Z'),
      ]))

    render(<Harness runId="run-1" />)

    await waitFor(() => expect(openRunEventStreamMock).toHaveBeenCalledTimes(2))
    expect(openRunEventStreamMock.mock.calls[1]?.[1]).toMatchObject({
      lastEventId: `${createdAt}|evt-500`,
    })
    await waitFor(() => {
      expect(useWorkflowStore.getState().events.map(event => event.id)).toEqual(['evt-500', 'evt-501'])
    })
    expect(useWorkflowStore.getState().streamTransport).toBe('sse')
  })

  it('does not open a stream and sets transport idle when runId is null', () => {
    render(<Harness runId={null} />)
    expect(openRunEventStreamMock).not.toHaveBeenCalled()
    expect(useWorkflowStore.getState().streamTransport).toBe('idle')
  })
})

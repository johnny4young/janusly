import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

import { readDeadLetterDetail } from '../lib/dead-letter-contract'
import type { DeadLetter } from './dead-letter-types'
import { ActivityRecoveryDetail } from './ActivityRecoveryDetail'

vi.mock('../lib/dead-letter-contract', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/dead-letter-contract')>()),
  readDeadLetterDetail: vi.fn(),
}))

const summary: DeadLetter = {
  id: 'dlq-status', runId: 'run-status', nodeId: 'fetch', attempt: 1,
  status: 'open', errorJson: { message: 'old summary' },
}

type Detail = Awaited<ReturnType<typeof readDeadLetterDetail>>
function detail(status: 'open' | 'resolved', message: string): Detail {
  return {
    id: summary.id, orgId: 'default', runId: summary.runId, nodeId: summary.nodeId,
    attempt: 1, status, workflowJson: {}, nodeJson: {}, errorJson: { message },
    createdAt: null, replayedAt: null, replayClaimedAt: null,
    suspectVersion: null, drill: null, drillOutcome: null,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const handlers = {
  onOpenRun: vi.fn(), onReplay: vi.fn(), onResolve: vi.fn(),
  canUseRecovery: false, canStartRuns: false,
}

beforeEach(() => {
  vi.mocked(readDeadLetterDetail).mockReset()
})

it('refetches evidence when the same dead letter changes status and ignores the stale response', async () => {
  const oldRead = deferred<Detail>()
  const newRead = deferred<Detail>()
  vi.mocked(readDeadLetterDetail)
    .mockReturnValueOnce(oldRead.promise)
    .mockReturnValueOnce(newRead.promise)

  const { rerender } = render(<ActivityRecoveryDetail deadLetter={summary} {...handlers} />)
  await waitFor(() => expect(readDeadLetterDetail).toHaveBeenCalledTimes(1))
  const oldSignal = vi.mocked(readDeadLetterDetail).mock.calls[0]![1]

  rerender(<ActivityRecoveryDetail deadLetter={{ ...summary, status: 'resolved' }} {...handlers} />)
  await waitFor(() => expect(readDeadLetterDetail).toHaveBeenCalledTimes(2))
  expect(oldSignal?.aborted).toBe(true)

  await act(async () => { newRead.resolve(detail('resolved', 'fresh evidence')) })
  expect(screen.getByText(/fresh evidence/)).toBeInTheDocument()
  expect(screen.getByTestId('activity-recovery-detail').querySelector('.status-pill')).toHaveAttribute('data-status', 'resolved')

  await act(async () => { oldRead.resolve(detail('open', 'stale evidence')) })
  expect(screen.getByText(/fresh evidence/)).toBeInTheDocument()
  expect(screen.queryByText(/stale evidence/)).not.toBeInTheDocument()
})

it('does not reuse an initial detail with a different summary status', async () => {
  vi.mocked(readDeadLetterDetail).mockResolvedValue(detail('resolved', 'fresh detail'))
  render(<ActivityRecoveryDetail deadLetter={{ ...summary, status: 'resolved' }}
    initialDetail={detail('open', 'stale detail')} {...handlers} />)

  await waitFor(() => expect(readDeadLetterDetail).toHaveBeenCalledTimes(1))
  expect(await screen.findByText(/fresh detail/)).toBeInTheDocument()
  expect(screen.queryByText(/stale detail/)).not.toBeInTheDocument()
})

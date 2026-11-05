import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { readDeadLetterDetail } from '../lib/dead-letter-contract'
import type { DeadLetter } from './dead-letter-types'
import { ActivityRecoveryDetail } from './ActivityRecoveryDetail'
import { deferred } from '../test/deferred'
import { useWorkflowStore } from '../store'

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

const handlers = {
  onOpenRun: vi.fn(), onReplay: vi.fn(), onResolve: vi.fn(),
  canUseRecovery: false, canStartRuns: false,
}

const initialStore = useWorkflowStore.getState()

beforeEach(() => {
  useWorkflowStore.setState({ ...initialStore }, true)
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

it('leads the evidence with the readable cause and keeps the raw error collapsed', async () => {
  vi.mocked(readDeadLetterDetail).mockResolvedValue(detail('open', 'lookup demo-ingest.invalid: no such host'))
  render(<ActivityRecoveryDetail deadLetter={summary} {...handlers} />)

  expect(await screen.findByText('Host demo-ingest.invalid does not resolve')).toBeInTheDocument()
  expect(screen.getByTestId('recovery-error-raw-toggle')).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByTestId('recovery-error-raw')).not.toBeInTheDocument()
})

it('closes only through the reason confirmation, with the facts of the failure it opened on', async () => {
  vi.mocked(readDeadLetterDetail).mockResolvedValue(detail('open', 'boom'))
  const onResolve = vi.fn(async () => true)
  const row = { ...summary, recovery: { occurrenceCount: 3 } as DeadLetter['recovery'] }
  render(<ActivityRecoveryDetail deadLetter={row} {...handlers} onResolve={onResolve} />)
  fireEvent.click(await screen.findByTestId('activity-recovery-close'))
  expect(onResolve).not.toHaveBeenCalled()
  expect(await screen.findByRole('alertdialog', undefined, { timeout: 30_000 })).toHaveTextContent('Occurrences3')
  expect(screen.getByTestId('dlq-close-confirm')).toBeDisabled()
  fireEvent.change(screen.getByTestId('dlq-close-reason'), { target: { value: 'Refunded by hand' } })
  fireEvent.click(screen.getByTestId('dlq-close-confirm'))
  await waitFor(() => expect(onResolve).toHaveBeenCalledWith(summary.id, 'Refunded by hand'))
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  expect(screen.getByTestId('activity-recovery-detail').querySelector('.status-pill')).toHaveAttribute('data-status', 'resolved')
})

it.each(['failure', 'organization'])('discards pending consent when the %s changes', async change => {
  vi.mocked(readDeadLetterDetail).mockResolvedValue(detail('open', 'boom'))
  const onResolve = vi.fn(async () => true)
  const { rerender } = render(<ActivityRecoveryDetail deadLetter={summary} {...handlers} onResolve={onResolve} />)
  fireEvent.click(await screen.findByTestId('activity-recovery-close'))
  await screen.findByRole('alertdialog', undefined, { timeout: 30_000 })
  if (change === 'organization') act(() => useWorkflowStore.setState({ orgId: 'other-org' }))
  else rerender(<ActivityRecoveryDetail deadLetter={{ ...summary, id: 'dlq-next' }} {...handlers} onResolve={onResolve} />)
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  expect(onResolve).not.toHaveBeenCalled()
})

describe('Suggest fix without an AI key', () => {
  const openDialog = async (canStartRuns: boolean) => {
    useWorkflowStore.setState({ aiHealth: { enabled: false, model: 'm', timeoutMs: 1, maxRetries: 0 } })
    vi.mocked(readDeadLetterDetail).mockResolvedValue(detail('open', 'boom'))
    render(<ActivityRecoveryDetail deadLetter={summary} {...handlers} canUseRecovery canStartRuns={canStartRuns} />)
    await screen.findByText(/boom/)
    fireEvent.click(screen.getByRole('button', { name: 'Suggest fix' }))
    await screen.findByTestId('recovery-availability')
  }

  it('offers Replay in Lab to an operator who may start runs', async () => {
    await openDialog(true)
    expect(screen.getByTestId('recovery-replay-in-lab')).toBeInTheDocument()
  })

  it('keeps Replay Lab out of the dialog for an operator who may not start runs', async () => {
    await openDialog(false)
    expect(screen.queryByTestId('recovery-replay-in-lab')).not.toBeInTheDocument()
    expect(screen.getByTestId('recovery-review-evidence')).toBeInTheDocument()
  })
})

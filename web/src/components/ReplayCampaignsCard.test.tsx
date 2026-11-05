import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { rotateApiRequestLifecycle } from '../api-request-lifecycle'
import { ReplayCampaignsCard } from './ReplayCampaignsCard'

vi.mock('../api', () => ({ api: vi.fn() }))

const addToast = vi.fn()
const bumpPlatformVersion = vi.fn()
vi.mock('../store', () => ({
  useWorkflowStore: (selector: (state: unknown) => unknown) => selector({
    addToast,
    bumpPlatformVersion,
  }),
}))

const runningCampaign = {
  id: 'campaign-1',
  name: 'Payments recovery',
  pacingMs: 5_000,
  status: 'running',
  totalCount: 4,
  replayedCount: 1,
  failedCount: 1,
  cancelledCount: 0,
  createdBy: 'dev-user',
  createdAt: '2026-07-21T12:00:00.000Z',
}

describe('<ReplayCampaignsCard />', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    addToast.mockReset()
    bumpPlatformVersion.mockReset()
  })

  afterEach(async () => {
    // Settle the module-level watch so it cannot leak into the next test.
    vi.useRealTimers()
    vi.mocked(api).mockResolvedValue({ campaigns: [] })
    render(<ReplayCampaignsCard />)
    await screen.findByTestId('recovery-jobs-empty')
  })

  it('renders bounded progress and counters, and no opaque user id', async () => {
    vi.mocked(api).mockResolvedValueOnce({ campaigns: [runningCampaign] })

    render(<ReplayCampaignsCard />)

    const row = await screen.findByTestId('replay-campaign-campaign-1')
    expect(row).toHaveTextContent('Payments recovery')
    expect(row).toHaveTextContent('Cluster · 4 items')
    expect(row).toHaveTextContent('2 of 4 settled')
    expect(row).not.toHaveTextContent('dev-user')
    expect(screen.queryByRole('columnheader', { name: 'Started by' })).not.toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Replays started' })).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'Progress for Payments recovery' })).toHaveAttribute('aria-valuenow', '2')
    expect(api).toHaveBeenCalledWith('/recovery/campaigns?limit=50')
  })

  it('says so when there are no jobs and offers New only when allowed', async () => {
    vi.mocked(api).mockResolvedValueOnce({ campaigns: [] })
    const onNew = vi.fn()

    const { unmount } = render(<ReplayCampaignsCard onNew={onNew} />)

    expect(await screen.findByTestId('recovery-jobs-empty')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('recovery-jobs-new'))
    expect(onNew).toHaveBeenCalledTimes(1)
    unmount()

    vi.mocked(api).mockResolvedValueOnce({ campaigns: [] })
    render(<ReplayCampaignsCard />)
    await screen.findByTestId('recovery-jobs-empty')
    expect(screen.queryByTestId('recovery-jobs-new')).not.toBeInTheDocument()
  })

  it('reloads from the server when refresh is pressed', async () => {
    vi.mocked(api).mockResolvedValueOnce({ campaigns: [] }).mockResolvedValueOnce({ campaigns: [runningCampaign] })

    render(<ReplayCampaignsCard />)
    await screen.findByTestId('recovery-jobs-empty')
    fireEvent.click(screen.getByTestId('recovery-jobs-refresh'))

    expect(await screen.findByTestId('replay-campaign-campaign-1')).toBeInTheDocument()
  })

  it('requires confirmation before aborting, announces once and refreshes shared state', async () => {
    const cancelled = { ...runningCampaign, status: 'cancelled', cancelledCount: 2 }
    vi.mocked(api)
      .mockResolvedValueOnce({ campaigns: [runningCampaign] })
      .mockResolvedValueOnce({ campaign: cancelled })
      .mockResolvedValueOnce({ campaigns: [cancelled] })

    render(<ReplayCampaignsCard />)
    fireEvent.click(await screen.findByTestId('replay-campaign-cancel-campaign-1'))
    expect(api).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('replay-campaign-cancel-confirm-campaign-1'))

    await waitFor(() => expect(api).toHaveBeenCalledWith('/recovery/campaigns/campaign-1/cancel', { method: 'POST' }))
    await waitFor(() => expect(screen.queryByTestId('replay-campaign-cancel-campaign-1')).not.toBeInTheDocument())
    expect(bumpPlatformVersion).toHaveBeenCalledTimes(1)
    expect(addToast).toHaveBeenCalledTimes(1)
    expect(addToast).toHaveBeenCalledWith('Payments recovery cancelled', 'success')
  })

  it('hides Abort from an operator who cannot replay, but still lists runs', async () => {
    vi.mocked(api).mockResolvedValueOnce({ campaigns: [runningCampaign] })

    render(<ReplayCampaignsCard canCancel={false} />)

    expect(await screen.findByTestId('recovery-job-view-runs-campaign-1')).toBeInTheDocument()
    expect(screen.queryByTestId('replay-campaign-cancel-campaign-1')).not.toBeInTheDocument()
  })

  it('lists what the API returns under View runs and opens a run', async () => {
    const onOpenRun = vi.fn()
    vi.mocked(api)
      .mockResolvedValueOnce({ campaigns: [{ ...runningCampaign, status: 'completed' }] })
      .mockResolvedValueOnce({
        items: [
          { id: 'item-1', deadLetterId: 'dead-letter-1', runId: 'run-12345678', nodeId: 'fetch', status: 'replayed', errorCode: null },
          { id: 'item-2', deadLetterId: 'dead-letter-2', runId: null, nodeId: null, status: 'failed', errorCode: 'rerun_exists' },
          { id: 'item-3', deadLetterId: 'dead-letter-3', runId: null, nodeId: null, status: 'failed', errorCode: 'something_new', error: 'claim replay: conn closed' },
        ],
      })

    render(<ReplayCampaignsCard onOpenRun={onOpenRun} />)
    const toggle = await screen.findByTestId('recovery-job-view-runs-campaign-1')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)

    const runs = await screen.findByTestId('recovery-job-runs-campaign-1')
    expect(api).toHaveBeenCalledWith('/recovery/campaigns/campaign-1')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(runs).toHaveTextContent('fetch')
    expect(runs).toHaveTextContent('Replay started')
    expect(runs).toHaveTextContent('Already ran in a rerun. Open the latest run.')
    expect(runs).toHaveTextContent('The replay could not start')
    expect(runs).not.toHaveTextContent('claim replay')
    // A pruned dead letter has no run to open; its id is listed without a link.
    expect(runs).toHaveTextContent('dead-let')
    expect(screen.queryByTestId('recovery-job-run-item-2')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('recovery-job-run-item-1'))
    expect(onOpenRun).toHaveBeenCalledWith('run-12345678')
  })

  it('reports a failed run list instead of showing an empty one', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({ campaigns: [{ ...runningCampaign, status: 'completed' }] })
      .mockRejectedValueOnce(new Error('boom'))

    render(<ReplayCampaignsCard />)
    fireEvent.click(await screen.findByTestId('recovery-job-view-runs-campaign-1'))

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the runs of this job')
  })

  it('announces the end of a watched job after the view unmounts, and only once', async () => {
    vi.useFakeTimers()
    const finished = { ...runningCampaign, status: 'completed', replayedCount: 3, failedCount: 1 }
    vi.mocked(api).mockResolvedValueOnce({ campaigns: [runningCampaign] })

    const { unmount } = render(<ReplayCampaignsCard />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByTestId('replay-campaign-campaign-1')).toBeInTheDocument()
    unmount()

    // A failed poll keeps watching, later.
    vi.mocked(api).mockRejectedValueOnce(new Error('offline'))
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    expect(addToast).not.toHaveBeenCalled()

    vi.mocked(api).mockResolvedValue({ campaigns: [finished] })
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000) })
    expect(addToast).toHaveBeenCalledTimes(1)
    expect(addToast).toHaveBeenCalledWith('Payments recovery finished. Replays started: 3. Could not start: 1.', 'error')
    expect(bumpPlatformVersion).toHaveBeenCalledWith(['campaigns', 'recovery', 'dlq'])

    const callsAfterEnd = vi.mocked(api).mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000) })
    expect(vi.mocked(api).mock.calls.length).toBe(callsAfterEnd)
    expect(addToast).toHaveBeenCalledTimes(1)
  })

  it('drops the watch when the session changes', async () => {
    vi.useFakeTimers()
    vi.mocked(api).mockResolvedValueOnce({ campaigns: [runningCampaign] })
    const { unmount } = render(<ReplayCampaignsCard />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    unmount()

    rotateApiRequestLifecycle()
    vi.mocked(api).mockClear()
    vi.mocked(api).mockResolvedValue({ campaigns: [{ ...runningCampaign, status: 'completed' }] })
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000) })

    expect(api).not.toHaveBeenCalled()
    expect(addToast).not.toHaveBeenCalled()
  })

  it('keeps a mounted view live across a session change', async () => {
    vi.useFakeTimers()
    vi.mocked(api).mockResolvedValueOnce({ campaigns: [runningCampaign] })
    render(<ReplayCampaignsCard />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    rotateApiRequestLifecycle()
    const otherOrgJob = { ...runningCampaign, id: 'campaign-2', name: 'Other org job' }
    vi.mocked(api).mockResolvedValue({ campaigns: [otherOrgJob] })
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })

    expect(screen.getByTestId('replay-campaign-campaign-2')).toBeInTheDocument()
    vi.mocked(api).mockResolvedValue({ campaigns: [{ ...otherOrgJob, replayedCount: 2 }] })
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    expect(screen.getByTestId('replay-campaign-campaign-2')).toHaveTextContent('3 of 4 settled')
    expect(addToast).not.toHaveBeenCalled()
  })

  it('says replays started, in a neutral tone, when no replay failed to start', async () => {
    vi.useFakeTimers()
    vi.mocked(api).mockResolvedValueOnce({ campaigns: [runningCampaign] })
    render(<ReplayCampaignsCard />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    vi.mocked(api).mockResolvedValue({ campaigns: [{ ...runningCampaign, status: 'completed', replayedCount: 4, failedCount: 0 }] })
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })

    expect(addToast).toHaveBeenCalledWith('Payments recovery finished. Replays started: 4. Could not start: 0.', 'info')
    const row = screen.getByTestId('replay-campaign-campaign-1')
    expect(row).toHaveTextContent('Finished')
    expect(row.querySelector('.we-pill')).toHaveAttribute('data-tone', 'neutral')
  })

  it('does not poll again while a poll is in flight', async () => {
    vi.useFakeTimers()
    vi.mocked(api).mockResolvedValueOnce({ campaigns: [runningCampaign] })
    render(<ReplayCampaignsCard />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    let resolvePoll: (value: unknown) => void = () => undefined
    vi.mocked(api).mockReturnValueOnce(new Promise((resolve) => { resolvePoll = resolve }))
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000) })
    expect(api).toHaveBeenCalledTimes(2)

    vi.mocked(api).mockResolvedValue({ campaigns: [runningCampaign] })
    await act(async () => { resolvePoll({ campaigns: [runningCampaign] }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    expect(api).toHaveBeenCalledTimes(3)
  })

  it('ignores an older response that arrives after a newer one', async () => {
    vi.useFakeTimers()
    const finished = { ...runningCampaign, status: 'completed', replayedCount: 3, failedCount: 1 }
    vi.mocked(api).mockResolvedValueOnce({ campaigns: [runningCampaign] })
    render(<ReplayCampaignsCard />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    let resolveOlder: (value: unknown) => void = () => undefined
    vi.mocked(api).mockReturnValueOnce(new Promise((resolve) => { resolveOlder = resolve }))
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    vi.mocked(api).mockResolvedValueOnce({ campaigns: [finished] })
    fireEvent.click(screen.getByTestId('recovery-jobs-refresh'))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(addToast).toHaveBeenCalledTimes(1)

    await act(async () => { resolveOlder({ campaigns: [runningCampaign] }) })
    expect(screen.getByTestId('replay-campaign-campaign-1')).toHaveTextContent('Finished')

    const calls = vi.mocked(api).mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000) })
    expect(vi.mocked(api).mock.calls.length).toBe(calls)
    expect(addToast).toHaveBeenCalledTimes(1)
  })

  it('announces an abort once when a stale running response lands around it', async () => {
    vi.useFakeTimers()
    const cancelled = { ...runningCampaign, status: 'cancelled', cancelledCount: 2 }
    vi.mocked(api).mockResolvedValueOnce({ campaigns: [runningCampaign] })
    render(<ReplayCampaignsCard />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    fireEvent.click(screen.getByTestId('replay-campaign-cancel-campaign-1'))

    // A poll leaves before the abort commits and lands before the refresh after it.
    let resolvePoll: (value: unknown) => void = () => undefined
    vi.mocked(api).mockReturnValueOnce(new Promise((resolve) => { resolvePoll = resolve }))
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    let resolveRefresh: (value: unknown) => void = () => undefined
    vi.mocked(api)
      .mockResolvedValueOnce({ campaign: cancelled })
      .mockReturnValueOnce(new Promise((resolve) => { resolveRefresh = resolve }))
    fireEvent.click(screen.getByTestId('replay-campaign-cancel-confirm-campaign-1'))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    await act(async () => { resolvePoll({ campaigns: [runningCampaign] }) })
    await act(async () => { resolveRefresh({ campaigns: [cancelled] }) })

    expect(addToast).toHaveBeenCalledTimes(1)
    expect(addToast).toHaveBeenCalledWith('Payments recovery cancelled', 'success')
    expect(screen.getByTestId('replay-campaign-campaign-1')).toHaveTextContent('Cancelled')
  })

  it.each([401, 403])('stops polling on %i and says the list is out of date', async (statusCode) => {
    vi.useFakeTimers()
    vi.mocked(api).mockResolvedValueOnce({ campaigns: [runningCampaign] })
    render(<ReplayCampaignsCard />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    vi.mocked(api).mockRejectedValue(Object.assign(new Error('denied'), { statusCode }))
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    expect(api).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('recovery-jobs-failed')).toHaveTextContent('Could not load recovery jobs')

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(api).toHaveBeenCalledTimes(2)

    vi.mocked(api).mockResolvedValue({ campaigns: [{ ...runningCampaign, status: 'completed' }] })
    fireEvent.click(screen.getByTestId('recovery-jobs-refresh'))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.queryByTestId('recovery-jobs-failed')).not.toBeInTheDocument()
  })

  it('backs off on repeated failures and resumes after a success', async () => {
    vi.useFakeTimers()
    vi.mocked(api).mockResolvedValueOnce({ campaigns: [runningCampaign] })
    render(<ReplayCampaignsCard />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    vi.mocked(api).mockRejectedValue(new Error('offline'))
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    // Polls at 3 s, 9 s, 21 s and 45 s, after the first read.
    expect(api).toHaveBeenCalledTimes(5)

    vi.mocked(api).mockResolvedValue({ campaigns: [runningCampaign] })
    await act(async () => { await vi.advanceTimersByTimeAsync(33_000) })
    expect(api).toHaveBeenCalledTimes(6)
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
    expect(api).toHaveBeenCalledTimes(7)
  })

  it('says when the list reached its limit', async () => {
    const jobs = Array.from({ length: 50 }, (_, index) => ({ ...runningCampaign, id: `job-${index}`, status: 'completed' }))
    vi.mocked(api).mockResolvedValueOnce({ campaigns: jobs })
    const { unmount } = render(<ReplayCampaignsCard />)
    expect(await screen.findByTestId('recovery-jobs-limit')).toHaveTextContent('Showing the latest 50 jobs')
    unmount()

    vi.mocked(api).mockResolvedValueOnce({ campaigns: jobs.slice(1) })
    render(<ReplayCampaignsCard />)
    await screen.findByTestId('replay-campaign-job-1')
    expect(screen.queryByTestId('recovery-jobs-limit')).not.toBeInTheDocument()
  })

  it('reports a failed list instead of claiming there are no jobs', async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error('boom'))

    render(<ReplayCampaignsCard />)

    expect(await screen.findByTestId('recovery-jobs-failed')).toBeInTheDocument()
    expect(screen.queryByTestId('recovery-jobs-empty')).not.toBeInTheDocument()
  })

  it('does not announce a job that was never seen running', async () => {
    vi.mocked(api).mockResolvedValueOnce({ campaigns: [{ ...runningCampaign, status: 'completed' }] })

    render(<ReplayCampaignsCard />)

    await screen.findByTestId('replay-campaign-campaign-1')
    expect(addToast).not.toHaveBeenCalled()
  })
})

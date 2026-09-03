import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { ReplayCampaignsCard } from './ReplayCampaignsCard'

vi.mock('../api', () => ({ api: vi.fn() }))

const addToast = vi.fn()
const bumpPlatformVersion = vi.fn()
vi.mock('../store', () => ({
  useWorkflowStore: (selector: (state: unknown) => unknown) => selector({
    platformVersion: 0,
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
  createdAt: '2026-07-21T12:00:00.000Z',
  nextDispatchAt: '2026-07-21T12:00:05.000Z',
}

describe('<ReplayCampaignsCard />', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    addToast.mockReset()
    bumpPlatformVersion.mockReset()
  })

  it('renders bounded progress and outcome counters', async () => {
    vi.mocked(api).mockResolvedValueOnce({ campaigns: [runningCampaign] })

    render(<ReplayCampaignsCard />)

    expect(await screen.findByText('Payments recovery')).toBeInTheDocument()
    expect(screen.getByText('2 of 4 settled')).toBeInTheDocument()
    expect(screen.getByText('Replayed: 1 · Failed: 1')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'Progress for Payments recovery' })).toHaveAttribute('aria-valuenow', '2')
  })

  it('requires confirmation before cancelling and refreshes shared state', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({ campaigns: [runningCampaign] })
      .mockResolvedValueOnce({ campaign: { ...runningCampaign, status: 'cancelled', cancelledCount: 2 } })
      .mockResolvedValueOnce({ campaigns: [{ ...runningCampaign, status: 'cancelled', cancelledCount: 2 }] })

    render(<ReplayCampaignsCard />)
    fireEvent.click(await screen.findByTestId('replay-campaign-cancel-campaign-1'))
    expect(api).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('replay-campaign-cancel-confirm-campaign-1'))

    await waitFor(() => expect(api).toHaveBeenCalledWith('/recovery/campaigns/campaign-1/cancel', { method: 'POST' }))
    expect(bumpPlatformVersion).toHaveBeenCalledTimes(1)
    expect(addToast).toHaveBeenCalledWith('Payments recovery stopped', 'success')
  })
})

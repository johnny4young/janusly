import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { ReplayCampaignDialog } from './ReplayCampaignDialog'

vi.mock('../api', () => ({ api: vi.fn() }))

describe('<ReplayCampaignDialog />', () => {
  beforeEach(() => { vi.mocked(api).mockReset() })

  it('previews one matching cohort and creates a paced campaign', async () => {
    const onCreated = vi.fn()
    vi.mocked(api)
      .mockResolvedValueOnce({
        canCreate: true,
        clusterSignature: 'sig-http-502',
        eligible: [
          { deadLetterId: 'dlq-1', runId: 'run-1', nodeId: 'fetch' },
          { deadLetterId: 'dlq-2', runId: 'run-2', nodeId: 'fetch' },
        ],
        rejected: [],
      })
      .mockResolvedValueOnce({
        campaign: { id: 'campaign-1', name: 'Payments recovery', totalCount: 2, pacingMs: 10_000 },
        publicationDeferred: false,
      })

    render(
      <ReplayCampaignDialog
        deadLetterIds={['dlq-1', 'dlq-2']}
        onClose={vi.fn()}
        onCreated={onCreated}
      />,
    )

    expect(await screen.findByText('2 of 2 eligible')).toBeInTheDocument()
    expect(screen.getByText('One failure cluster')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('replay-campaign-name'), { target: { value: 'Payments recovery' } })
    fireEvent.change(screen.getByTestId('replay-campaign-pace'), { target: { value: '10000' } })
    fireEvent.click(screen.getByTestId('replay-campaign-create'))

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    expect(api).toHaveBeenNthCalledWith(2, '/recovery/campaigns', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ deadLetterIds: ['dlq-1', 'dlq-2'], name: 'Payments recovery', pacingMs: 10_000 }),
    }))
  })

  it('explains a mixed cohort and keeps creation disabled', async () => {
    vi.mocked(api).mockResolvedValueOnce({
      canCreate: false,
      clusterSignature: 'sig-http-502',
      eligible: [{ deadLetterId: 'dlq-1', runId: 'run-1', nodeId: 'fetch' }],
      rejected: [{ deadLetterId: 'dlq-2', reason: 'different_cluster' }],
    })

    render(
      <ReplayCampaignDialog
        deadLetterIds={['dlq-1', 'dlq-2']}
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    )

    expect(await screen.findByText('Selection needs attention')).toBeInTheDocument()
    expect(screen.getByText('Different failure cluster')).toBeInTheDocument()
    expect(screen.getByTestId('replay-campaign-create')).toBeDisabled()
  })

  it('closes on Escape once the preview is settled', async () => {
    const onClose = vi.fn()
    vi.mocked(api).mockResolvedValueOnce({
      canCreate: true,
      clusterSignature: 'sig',
      eligible: [
        { deadLetterId: 'dlq-1', runId: 'run-1', nodeId: 'fetch' },
        { deadLetterId: 'dlq-2', runId: 'run-2', nodeId: 'fetch' },
      ],
      rejected: [],
    })
    render(<ReplayCampaignDialog deadLetterIds={['dlq-1', 'dlq-2']} onClose={onClose} onCreated={vi.fn()} />)
    await screen.findByText('One failure cluster')

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

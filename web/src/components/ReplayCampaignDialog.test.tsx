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
    expect(screen.getByTestId('replay-campaign-stat-sideEffectSteps')).toHaveTextContent('0')
    expect(screen.queryByTestId('replay-campaign-side-effects')).not.toBeInTheDocument()
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

  it('counts the preview and names steps that may repeat an external change', async () => {
    vi.mocked(api).mockResolvedValueOnce({
      canCreate: true,
      clusterSignature: 'sig',
      eligible: [
        { deadLetterId: 'dlq-1', runId: 'run-1', nodeId: 'charge', sideEffect: true },
        { deadLetterId: 'dlq-2', runId: 'run-2', nodeId: 'charge', sideEffect: true },
        { deadLetterId: 'dlq-3', runId: 'run-2', nodeId: 'fetch', sideEffect: false },
      ],
      rejected: [],
    })
    render(<ReplayCampaignDialog deadLetterIds={['dlq-1', 'dlq-2', 'dlq-3']} onClose={vi.fn()} onCreated={vi.fn()} />)

    await screen.findByText('3 of 3 eligible')
    expect(screen.getByTestId('replay-campaign-stat-failures')).toHaveTextContent('3')
    expect(screen.getByTestId('replay-campaign-stat-runs')).toHaveTextContent('2')
    expect(screen.getByTestId('replay-campaign-stat-sideEffectSteps')).toHaveTextContent('1')
    expect(screen.getByTestId('replay-campaign-stat-estimate')).toHaveTextContent('~15 sec')
    const steps = screen.getByTestId('replay-campaign-side-effects')
    expect(steps).toHaveTextContent('charge')
    expect(steps).toHaveTextContent('2× · may change external systems')
    expect(steps).not.toHaveTextContent('fetch')

    fireEvent.change(screen.getByTestId('replay-campaign-pace'), { target: { value: '60000' } })
    expect(screen.getByTestId('replay-campaign-stat-estimate')).toHaveTextContent('~3 min')
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

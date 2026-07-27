import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { initI18n } from '../i18n'
import { AutoHealingPendingCard } from './AutoHealingPendingCard'

vi.mock('../api', () => ({ api: vi.fn() }))

const bumpPlatformVersion = vi.fn()

vi.mock('../store', () => ({
  useWorkflowStore: (selector: (state: {
    platformVersion: number
    bumpPlatformVersion: () => void
  }) => unknown) => selector({
    platformVersion: 0,
    bumpPlatformVersion,
  }),
}))

const pending = {
  id: 'heal-1',
  signature: 'HTTP write failed',
  approachLabel: 'add_retry',
  confidence: 84,
  deadLetterId: 'dlq-1',
  validationEvidenceLevel: 'writes_skipped',
  createdAt: '2026-07-26T10:00:00.000Z',
}

beforeEach(() => {
  initI18n('en')
  vi.mocked(api).mockReset().mockResolvedValue({ rows: [pending] })
  bumpPlatformVersion.mockReset()
})

describe('<AutoHealingPendingCard />', () => {
  it('requires explicit acknowledgement when external writes were skipped', async () => {
    render(<AutoHealingPendingCard />)

    expect(await screen.findByText('External writes skipped')).toBeInTheDocument()
    const apply = screen.getByRole('button', { name: 'Apply' })
    expect(apply).toBeDisabled()

    fireEvent.click(screen.getByRole('checkbox'))
    expect(apply).toBeEnabled()
    fireEvent.click(apply)

    await waitFor(() => expect(api).toHaveBeenCalledWith(
      '/auto-healing/heal-1/decide',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          accepted: true,
          acknowledgeValidationRisk: true,
        }),
      }),
    ))
  })

  it('allows a provider-simulated repair without the skipped-write warning', async () => {
    vi.mocked(api).mockResolvedValueOnce({
      rows: [{
        ...pending,
        validationEvidenceLevel: 'provider_simulated',
      }],
    })

    render(<AutoHealingPendingCard />)

    expect(await screen.findByText('Provider simulated')).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled()
  })

  it('fails closed when a legacy validation has no evidence level', async () => {
    vi.mocked(api).mockResolvedValueOnce({
      rows: [{
        ...pending,
        validationEvidenceLevel: null,
      }],
    })

    render(<AutoHealingPendingCard />)

    expect(await screen.findByText('Evidence unavailable')).toBeInTheDocument()
    const apply = screen.getByRole('button', { name: 'Apply' })
    expect(apply).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(apply).toBeEnabled()
  })

  it('reports that durable publication will continue after a transient queue failure', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({
        rows: [{
          ...pending,
          validationEvidenceLevel: 'provider_simulated',
        }],
      })
      .mockResolvedValueOnce({
        ok: false,
        accepted: true,
        status: 'pending',
      })

    render(<AutoHealingPendingCard />)
    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }))

    expect(await screen.findByRole('status')).toHaveTextContent(
      'The recovery was accepted and will be published automatically when queue delivery recovers.',
    )
    expect(bumpPlatformVersion).toHaveBeenCalledOnce()
  })
})

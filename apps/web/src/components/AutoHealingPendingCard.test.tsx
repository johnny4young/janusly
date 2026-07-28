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

const factor = (
  id: string,
  passed = true,
  reason = 'ready',
  actual: string | number | boolean | null = true,
  required: string | number | boolean | null = true,
) => ({ id, passed, reason, actual, required })

const autonomyAssessment = {
  eligible: false,
  failure: 'terminal_node_failure',
  repairClass: 'retry',
  policy: {
    level: 4,
    source: 'workflow_default',
    detectorIds: [],
    unavailableReason: null,
    capabilities: {
      observe: true,
      recommend: true,
      validate: true,
      applyWithApproval: true,
      autonomousApply: true,
    },
    factors: [],
  },
  validationEvidenceLevel: 'writes_skipped',
  minimumEvidenceLevel: 'provider_simulated',
  priorVerifiedRecoveries: 2,
  affectedExecutions: 1,
  factors: [
    factor('policy', true, 'ready', 4, 4),
    factor('repair_scope', true, 'ready', 'retry', 'retry'),
    factor(
      'validation_evidence',
      false,
      'validation_evidence_insufficient',
      'writes_skipped',
      'provider_simulated',
    ),
    factor('prior_recoveries', true, 'ready', 2, 2),
    factor('blast_radius', true, 'ready', 1, 1),
    factor('rollback'),
    factor('effect_receipts'),
  ],
}

const pending = {
  id: 'heal-1',
  signature: 'HTTP write failed',
  approachLabel: 'add_retry',
  confidence: 84,
  deadLetterId: 'dlq-1',
  validationEvidenceLevel: 'writes_skipped',
  createdAt: '2026-07-26T10:00:00.000Z',
  autonomyAssessment,
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
    expect(screen.getByText('Operator required')).toBeInTheDocument()
    expect(screen.getByText(
      'Validation did not exercise a provider boundary strongly enough.',
    )).toBeInTheDocument()
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
        autonomyAssessment: {
          ...autonomyAssessment,
          eligible: true,
          validationEvidenceLevel: 'provider_simulated',
          factors: autonomyAssessment.factors.map((item) => (
            item.id === 'validation_evidence'
              ? factor(
                  'validation_evidence',
                  true,
                  'ready',
                  'provider_simulated',
                  'provider_simulated',
                )
              : item
          )),
        },
      }],
    })

    render(<AutoHealingPendingCard />)

    expect(await screen.findByText('Provider simulated')).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled()
    expect(screen.getByText('Technically eligible')).toBeInTheDocument()
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

  it('fails closed when the autonomy projection is incomplete', async () => {
    vi.mocked(api).mockResolvedValueOnce({
      rows: [{
        ...pending,
        autonomyAssessment: {
          eligible: true,
          factors: [factor('policy')],
        },
      }],
    })

    render(<AutoHealingPendingCard />)

    expect(await screen.findByText(
      'The server could not prove the autonomy boundary. This repair must remain operator-controlled.',
    )).toBeInTheDocument()
    expect(screen.getByText('Operator required')).toBeInTheDocument()
  })

  it('fails closed when an autonomy factor has a malformed wire value', async () => {
    vi.mocked(api).mockResolvedValueOnce({
      rows: [{
        ...pending,
        autonomyAssessment: {
          ...autonomyAssessment,
          factors: autonomyAssessment.factors.map((item) => (
            item.id === 'repair_scope'
              ? { ...item, actual: { unexpected: true } }
              : item
          )),
        },
      }],
    })

    render(<AutoHealingPendingCard />)

    expect(await screen.findByText(
      'The server could not prove the autonomy boundary. This repair must remain operator-controlled.',
    )).toBeInTheDocument()
    expect(screen.getByText('Operator required')).toBeInTheDocument()
  })
})

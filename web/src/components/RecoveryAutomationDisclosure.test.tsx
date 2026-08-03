import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RecoveryAutomationDisclosure } from './RecoveryAutomationDisclosure'

const cardRenders = vi.hoisted(() => ({
  clusters: vi.fn(),
  campaigns: vi.fn(),
  autoHealing: vi.fn(),
}))

vi.mock('./FailureClustersCard', () => ({
  FailureClustersCard: () => {
    cardRenders.clusters()
    return <div data-testid="clusters-card" />
  },
}))

vi.mock('./ReplayCampaignsCard', () => ({
  ReplayCampaignsCard: () => {
    cardRenders.campaigns()
    return <div data-testid="campaigns-card" />
  },
}))

vi.mock('./AutoHealingPendingCard', () => ({
  AutoHealingPendingCard: () => {
    cardRenders.autoHealing()
    return <div data-testid="auto-healing-card" />
  },
}))

describe('<RecoveryAutomationDisclosure />', () => {
  beforeEach(() => {
    cardRenders.clusters.mockClear()
    cardRenders.campaigns.mockClear()
    cardRenders.autoHealing.mockClear()
  })

  it('keeps supplementary recovery surfaces unmounted until expanded', async () => {
    render(
      <RecoveryAutomationDisclosure
        canRecover
        canCancelCampaign
        canReadAutoHealing
        canDecideAutoHealing
      />,
    )

    const toggle = screen.getByTestId('recovery-automation-toggle')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(cardRenders.clusters).not.toHaveBeenCalled()
    expect(cardRenders.campaigns).not.toHaveBeenCalled()
    expect(cardRenders.autoHealing).not.toHaveBeenCalled()

    fireEvent.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findByTestId('clusters-card')).toBeInTheDocument()
    expect(screen.getByTestId('campaigns-card')).toBeInTheDocument()
    expect(screen.getByTestId('auto-healing-card')).toBeInTheDocument()
  })

  it('does not mount auto-healing without read permission', async () => {
    render(
      <RecoveryAutomationDisclosure
        canRecover={false}
        canCancelCampaign={false}
        canReadAutoHealing={false}
        canDecideAutoHealing={false}
      />,
    )

    fireEvent.click(screen.getByTestId('recovery-automation-toggle'))

    expect(await screen.findByTestId('clusters-card')).toBeInTheDocument()
    expect(screen.getByTestId('campaigns-card')).toBeInTheDocument()
    expect(screen.queryByTestId('auto-healing-card')).not.toBeInTheDocument()
  })
})

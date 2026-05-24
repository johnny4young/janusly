import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { RecoveryItemBadge, type RecoveryItemBadgeData } from './RecoveryItemBadge'

function makeItem(overrides: Partial<RecoveryItemBadgeData> = {}): RecoveryItemBadgeData {
  return {
    id: 'ri_1',
    owner: 'alice',
    severity: 'p2',
    status: 'acknowledged',
    slaTargetAtIso: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    ...overrides,
  }
}

describe('<RecoveryItemBadge />', () => {
  it('renders nothing when item is null (legacy DLQ row)', () => {
    const { container } = render(<RecoveryItemBadge item={null} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders severity + status + owner', () => {
    render(<RecoveryItemBadge item={makeItem()} />)
    expect(screen.getByTestId('recovery-item-severity').textContent).toMatch(/P2/)
    expect(screen.getByTestId('recovery-item-status').textContent).toMatch(/Acknowledged/)
    expect(screen.getByTitle('alice')).toBeInTheDocument()
  })

  it('SLA tone is red when target is in the past', () => {
    const past = new Date(Date.now() - 30 * 60 * 1_000).toISOString()
    render(<RecoveryItemBadge item={makeItem({ slaTargetAtIso: past })} />)
    expect(screen.getByTestId('recovery-item-sla').getAttribute('data-tone')).toBe('red')
  })

  it('SLA tone is green when more than 4h remain', () => {
    const far = new Date(Date.now() + 6 * 60 * 60 * 1_000).toISOString()
    render(<RecoveryItemBadge item={makeItem({ slaTargetAtIso: far })} />)
    expect(screen.getByTestId('recovery-item-sla').getAttribute('data-tone')).toBe('green')
  })

  it('does not render the SLA timer for resolved items', () => {
    render(<RecoveryItemBadge item={makeItem({ status: 'resolved' })} />)
    expect(screen.queryByTestId('recovery-item-sla')).toBeNull()
  })
})

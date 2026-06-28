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
    occurrenceCount: 1,
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

  it('shows the occurrence count pill only during a failure storm (count > 1)', () => {
    const { rerender } = render(<RecoveryItemBadge item={makeItem({ occurrenceCount: 1 })} />)
    expect(screen.queryByTestId('recovery-item-occurrences')).toBeNull()
    rerender(<RecoveryItemBadge item={makeItem({ occurrenceCount: 12 })} />)
    expect(screen.getByTestId('recovery-item-occurrences').textContent).toMatch(/12/)
  })

  it('aria-label announces localized severity/status + overdue SLA urgency', () => {
    const past = new Date(Date.now() - 30 * 60 * 1_000).toISOString()
    render(<RecoveryItemBadge item={makeItem({ slaTargetAtIso: past })} />)
    const label = screen.getByTestId('recovery-item-badge').getAttribute('aria-label') ?? ''
    expect(label).toMatch(/P2/) // localized severity label
    expect(label).toMatch(/Acknowledged/) // localized status label
    expect(label).toMatch(/overdue/i) // the urgency the red color band conveys
    expect(label).not.toMatch(/\bp2\b/) // raw enum code no longer leaks to AT
  })

  it('aria-label folds in the SLA time-remaining for an active item', () => {
    const future = new Date(Date.now() + 6 * 60 * 60 * 1_000).toISOString()
    render(<RecoveryItemBadge item={makeItem({ slaTargetAtIso: future })} />)
    const label = screen.getByTestId('recovery-item-badge').getAttribute('aria-label') ?? ''
    expect(label).toMatch(/SLA/)
    expect(label).toMatch(/\d/) // a relative-time figure (e.g. "in 6 hr")
  })

  it('aria-label omits the SLA clause for a resolved item', () => {
    render(<RecoveryItemBadge item={makeItem({ status: 'resolved' })} />)
    const label = screen.getByTestId('recovery-item-badge').getAttribute('aria-label') ?? ''
    expect(label).not.toMatch(/SLA/)
    expect(label).toMatch(/Resolved/)
  })
})

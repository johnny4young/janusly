import { fireEvent, render, screen } from '@testing-library/react'
import { CheckCircle2 } from 'lucide-react'
import { describe, expect, it, vi } from 'vitest'
import { EmptyState } from './EmptyState'

describe('<EmptyState />', () => {
  it('renders the icon slot, kicker, and body', () => {
    render(
      <EmptyState
        icon={<CheckCircle2 data-testid="es-icon" />}
        kicker="Nothing to recover"
        body="All clusters cleared up in this window."
      />,
    )

    expect(screen.getByTestId('empty-state')).toBeInTheDocument()
    expect(screen.getByTestId('es-icon')).toBeInTheDocument()
    expect(screen.getByText('Nothing to recover')).toBeInTheDocument()
    expect(screen.getByText('All clusters cleared up in this window.')).toBeInTheDocument()
  })

  it('omits the CTA button when no `cta` prop is supplied', () => {
    render(
      <EmptyState
        icon={<CheckCircle2 />}
        kicker="No alerts"
        body="Recent runs delivered cleanly."
      />,
    )

    expect(screen.queryByTestId('empty-state-cta')).not.toBeInTheDocument()
  })

  it('renders the CTA and fires `onClick` when supplied', () => {
    const onClick = vi.fn()
    render(
      <EmptyState
        icon={<CheckCircle2 />}
        kicker="No members yet"
        body="Invite someone to start collaborating."
        cta={{ label: 'Invite member', onClick }}
      />,
    )

    const cta = screen.getByTestId('empty-state-cta')
    expect(cta).toHaveTextContent('Invite member')
    fireEvent.click(cta)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

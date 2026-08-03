import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { RecoveryLabEntry } from './RecoveryCenterEmptyState'
import { shouldShowOnboarding } from './recovery-center-model'

describe('shouldShowOnboarding', () => {
  const fresh = { runs: 0, openFailures: 0, waitingApprovals: 0, dismissed: false }

  it('shows only for a truly fresh, non-dismissed workspace', () => {
    expect(shouldShowOnboarding(fresh)).toBe(true)
  })

  it('hides once dismissed', () => {
    expect(shouldShowOnboarding({ ...fresh, dismissed: true })).toBe(false)
  })

  it('hides when there is any prior activity', () => {
    expect(shouldShowOnboarding({ ...fresh, runs: 1 })).toBe(false)
    expect(shouldShowOnboarding({ ...fresh, openFailures: 1 })).toBe(false)
    expect(shouldShowOnboarding({ ...fresh, waitingApprovals: 1 })).toBe(false)
  })
})

describe('<RecoveryLabEntry /> dismiss', () => {
  it('renders no dismiss control when onDismiss is absent', () => {
    render(<RecoveryLabEntry onOpenStudio={() => {}} onOpenRecipes={() => {}} />)
    expect(screen.queryByTestId('recovery-lab-entry-dismiss')).toBeNull()
  })

  it('fires onDismiss when the control is clicked', () => {
    const onDismiss = vi.fn()
    render(<RecoveryLabEntry onOpenStudio={() => {}} onOpenRecipes={() => {}} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByTestId('recovery-lab-entry-dismiss'))
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})

describe('<RecoveryLabEntry /> controlled drill CTA', () => {
  it('renders no drill CTA without onStartDrill', () => {
    render(<RecoveryLabEntry onOpenStudio={() => {}} onOpenRecipes={() => {}} />)
    expect(screen.queryByTestId('recovery-center-empty-cta-drill')).toBeNull()
  })

  it('fires onStartDrill and renders no fabricated evidence', () => {
    const onStartDrill = vi.fn()
    render(<RecoveryLabEntry onOpenStudio={() => {}} onOpenRecipes={() => {}} onStartDrill={onStartDrill} />)
    fireEvent.click(screen.getByTestId('recovery-center-empty-cta-drill'))
    expect(onStartDrill).toHaveBeenCalledOnce()
    expect(screen.queryByText(/0x9af2|stripe\.charge|412ms|92 AI/)).toBeNull()
  })
})

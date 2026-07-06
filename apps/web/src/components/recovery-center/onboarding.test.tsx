import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { RecoveryFlowDemo } from './RecoveryCenterEmptyState'
import { shouldShowOnboarding } from './helpers'

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

describe('<RecoveryFlowDemo /> dismiss', () => {
  it('renders no dismiss control when onDismiss is absent', () => {
    render(<RecoveryFlowDemo onOpenStudio={() => {}} onOpenRecipes={() => {}} />)
    expect(screen.queryByTestId('recovery-flow-demo-dismiss')).toBeNull()
  })

  it('fires onDismiss when the control is clicked', () => {
    const onDismiss = vi.fn()
    render(<RecoveryFlowDemo onOpenStudio={() => {}} onOpenRecipes={() => {}} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByTestId('recovery-flow-demo-dismiss'))
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})

describe('<RecoveryFlowDemo /> try-demo CTA', () => {
  it('renders no demo CTA without onTryDemo', () => {
    render(<RecoveryFlowDemo onOpenStudio={() => {}} onOpenRecipes={() => {}} />)
    expect(screen.queryByTestId('recovery-center-empty-cta-demo')).toBeNull()
  })

  it('fires onTryDemo when the demo CTA is clicked', () => {
    const onTryDemo = vi.fn()
    render(<RecoveryFlowDemo onOpenStudio={() => {}} onOpenRecipes={() => {}} onTryDemo={onTryDemo} />)
    fireEvent.click(screen.getByTestId('recovery-center-empty-cta-demo'))
    expect(onTryDemo).toHaveBeenCalledOnce()
  })
})

import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { OnboardingState, OnboardingStep } from '@janusly/shared/src/onboarding'
import { OnboardingBanner } from './OnboardingBanner'
import { useWorkflowStore } from '../store'

vi.mock('../api', () => ({ api: vi.fn() }))
import { api } from '../api'
const apiMock = vi.mocked(api)

function buildState(overrides: Partial<OnboardingState> = {}): OnboardingState {
  const milestones: OnboardingState['milestones'] = [
    { step: 'org_created', done: true, order: 0, target: 'home' },
    { step: 'credential_configured', done: false, order: 1, target: 'credentials' },
    { step: 'pack_installed', done: false, order: 2, target: 'packs' },
    { step: 'first_run_succeeded', done: false, order: 3, target: 'packs' },
    { step: 'failure_injected', done: false, order: 4, target: 'packs' },
    { step: 'recovery_applied', done: false, order: 5, target: 'home' },
    { step: 'completed', done: false, order: 6, target: 'home' },
  ]
  return {
    enabled: true,
    status: 'active',
    currentStep: 'credential_configured',
    completed: false,
    aiAvailable: true,
    skippedAt: null,
    completedAt: null,
    milestones,
    ...overrides,
  }
}

function mount(state: OnboardingState | null) {
  useWorkflowStore.setState({ onboarding: state, authReady: true, platformVersion: 0 })
  apiMock.mockResolvedValue(state)
  return render(<OnboardingBanner onOpenTab={vi.fn()} />)
}

beforeEach(() => {
  useWorkflowStore.setState({ onboarding: null, authReady: false, platformVersion: 0 })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('OnboardingBanner', () => {
  it('renders the current step title + CTA while active', () => {
    mount(buildState())
    expect(screen.getByTestId('onboarding-banner')).toBeTruthy()
    expect(screen.getByText('Configure a credential')).toBeTruthy()
    expect(screen.getByTestId('onboarding-banner-cta').textContent).toContain('Add a credential')
  })

  it('renders nothing when onboarding is completed', () => {
    mount(buildState({ status: 'completed', currentStep: null, completed: true }))
    expect(screen.queryByTestId('onboarding-banner')).toBeNull()
  })

  it('renders nothing when onboarding is skipped', () => {
    mount(buildState({ status: 'skipped' }))
    expect(screen.queryByTestId('onboarding-banner')).toBeNull()
  })

  it('renders nothing when the tenant toggle is disabled', () => {
    mount(buildState({ enabled: false }))
    expect(screen.queryByTestId('onboarding-banner')).toBeNull()
  })

  it('renders nothing when no step remains', () => {
    mount(buildState({ currentStep: null }))
    expect(screen.queryByTestId('onboarding-banner')).toBeNull()
  })

  it('shows the deterministic-fallback copy when AI is unavailable', () => {
    mount(buildState({ currentStep: 'first_run_succeeded' as OnboardingStep, aiAvailable: false }))
    expect(screen.getByText(/built-in fallback/i)).toBeTruthy()
  })

  it('POSTs a skip action and stores the refreshed state', async () => {
    mount(buildState())
    apiMock.mockResolvedValueOnce(buildState({ status: 'skipped' }))
    fireEvent.click(screen.getByTestId('onboarding-banner-skip'))
    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        '/onboarding',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ action: 'skip' }) }),
      )
    })
    await waitFor(() => expect(useWorkflowStore.getState().onboarding?.status).toBe('skipped'))
  })
})

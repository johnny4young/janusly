import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { OnboardingState } from '@/lib/onboarding'
import { OnboardingReplayButton } from './OnboardingReplayButton'
import { useWorkflowStore } from '../store'

vi.mock('../api', () => ({ api: vi.fn() }))
import { api } from '../api'
const apiMock = vi.mocked(api)

function state(overrides: Partial<OnboardingState> = {}): OnboardingState {
  return {
    enabled: true,
    status: 'completed',
    currentStep: null,
    completed: true,
    aiAvailable: true,
    skippedAt: null,
    completedAt: '2026-01-01T00:00:00Z',
    milestones: [],
    ...overrides,
  }
}

beforeEach(() => {
  useWorkflowStore.setState({ onboarding: null })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('OnboardingReplayButton', () => {
  it('renders nothing when onboarding state is absent', () => {
    render(<OnboardingReplayButton />)
    expect(screen.queryByTestId('onboarding-replay')).toBeNull()
  })

  it('renders nothing while onboarding is still active (the banner is showing)', () => {
    useWorkflowStore.setState({
      onboarding: state({ status: 'active', currentStep: 'credential_configured', completed: false }),
    })
    render(<OnboardingReplayButton />)
    expect(screen.queryByTestId('onboarding-replay')).toBeNull()
  })

  it('renders nothing when the tenant toggle is disabled', () => {
    useWorkflowStore.setState({ onboarding: state({ enabled: false }) })
    render(<OnboardingReplayButton />)
    expect(screen.queryByTestId('onboarding-replay')).toBeNull()
  })

  it('shows when onboarding is completed', () => {
    useWorkflowStore.setState({ onboarding: state({ status: 'completed' }) })
    render(<OnboardingReplayButton />)
    expect(screen.getByTestId('onboarding-replay')).toBeTruthy()
  })

  it('shows when onboarding is skipped', () => {
    useWorkflowStore.setState({ onboarding: state({ status: 'skipped' }) })
    render(<OnboardingReplayButton />)
    expect(screen.getByTestId('onboarding-replay')).toBeTruthy()
    expect(screen.getByTestId('onboarding-replay').textContent).toContain('Resume onboarding')
  })

  it('POSTs a restart action on click and stores the refreshed state', async () => {
    useWorkflowStore.setState({ onboarding: state({ status: 'completed' }) })
    apiMock.mockResolvedValueOnce(
      state({ status: 'active', currentStep: 'credential_configured', completed: false }),
    )
    render(<OnboardingReplayButton />)
    fireEvent.click(screen.getByTestId('onboarding-replay'))
    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        '/onboarding',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ action: 'restart' }) }),
      )
    })
    await waitFor(() => expect(useWorkflowStore.getState().onboarding?.status).toBe('active'))
  })

  it('POSTs resume, not restart, when onboarding was skipped', async () => {
    useWorkflowStore.setState({ onboarding: state({ status: 'skipped', completed: false }) })
    apiMock.mockResolvedValueOnce(
      state({ status: 'active', currentStep: 'pack_installed', completed: false }),
    )
    render(<OnboardingReplayButton />)
    fireEvent.click(screen.getByTestId('onboarding-replay'))
    await waitFor(() => {
      expect(apiMock).toHaveBeenCalledWith(
        '/onboarding',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ action: 'resume' }) }),
      )
    })
    await waitFor(() => expect(useWorkflowStore.getState().onboarding?.status).toBe('active'))
  })
})

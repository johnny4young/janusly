import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import { OperationsPanel } from './OperationsPanel'

vi.mock('../api', () => ({
  api: vi.fn(),
}))

vi.mock('./FailureClustersCard', () => ({
  FailureClustersCard: () => <section>Failure clusters loaded</section>,
}))

const initialState = useWorkflowStore.getState()

const metricsPayload = {
  windowDays: 30,
  terminalRuns: 12,
  successRate: { value: 95, display: '95.0%', severity: 'healthy', rationale: '11 of 12 terminal runs succeeded.' },
  mttr: { value: 90_000, display: '1m 30s', severity: 'healthy', rationale: 'Fast recovery.' },
  p95Latency: { value: 4_000, display: '4.0s', severity: 'healthy', rationale: 'p95 across all runs.' },
  approvalsPending: { value: 2, display: '2', severity: 'neutral', rationale: 'Current state.' },
  replayRate: { value: 90, display: '90.0%', severity: 'healthy', rationale: '9 replays succeeded.' },
  costThisWindow: {
    value: 12.34,
    display: '$12.34',
    severity: 'neutral',
    rationale: 'Across 1 provider.',
    providers: [{ provider: 'OpenAI', model: 'gpt-4o-mini', usd: 12.34, tokens: 12345, calls: 8 }],
  },
}

describe('<OperationsPanel />', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    useWorkflowStore.setState({ ...initialState, platformVersion: 0 }, true)
  })

  // Dispatch helper — OperationsPanel mounts the FailureClustersCard
  // and the BudgetSettingsPanel as children, each making their own
  // api(...) calls on the same render tick. Order-of-effect is not
  // guaranteed, so we stub by path rather than by order.
  function stubApiByPath(handlers: Record<string, unknown | ((path: string, init?: RequestInit) => unknown)>) {
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      for (const key of Object.keys(handlers)) {
        if (path === key || path.startsWith(`${key}?`)) {
          const value = handlers[key]
          if (typeof value === 'function') return (value as (path: string, init?: RequestInit) => unknown)(path, init)
          return value as unknown
        }
      }
      // Unmatched paths get a benign empty payload so child fetches
      // (BudgetSettingsPanel's /org/config + /workflows) don't blow up
      // the test assertions for OperationsPanel.
      return Array.isArray(handlers["*"]) ? handlers["*"] : []
    })
  }

  it('renders the loading state while metrics are in flight', () => {
    stubApiByPath({ '/recovery/metrics': new Promise(() => undefined) })

    render(<OperationsPanel />)

    expect(screen.getByText(/Computing recovery metrics/i)).toBeInTheDocument()
  })

  it('renders metric cards, cost breakdown, and failure clusters on success', async () => {
    stubApiByPath({ '/recovery/metrics': metricsPayload })

    render(<OperationsPanel />)

    expect(await screen.findByText('95.0%')).toBeInTheDocument()
    expect(screen.getByText('Mean time to recovery')).toBeInTheDocument()
    expect(screen.getByText('Replay success rate')).toBeInTheDocument()
    expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument()
    expect(screen.getByText('Failure clusters loaded')).toBeInTheDocument()
  })

  it('renders an error state when the metrics endpoint fails', async () => {
    stubApiByPath({ '/recovery/metrics': Promise.reject(new Error('service down')) })

    render(<OperationsPanel />)

    await waitFor(() => {
      expect(screen.getByText(/Recovery metrics unavailable — service down/i)).toBeInTheDocument()
    })
  })
})

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import { WorkflowHealthBadge } from './WorkflowHealthBadge'

vi.mock('../api', () => ({ api: vi.fn() }))

const initialState = useWorkflowStore.getState()

function makeHealth(overrides?: Partial<{ score: number; status: string; slo: unknown }>) {
  return {
    score: 82,
    status: 'healthy',
    breakdown: {
      reliability: { score: 90, rationale: 'r', rationaleCode: 'reliability.summary' },
      safety: { score: 90, rationale: 's', rationaleCode: 'safety.clean' },
      cost: { score: 90, rationale: 'c', rationaleCode: 'cost.none' },
      latency: { score: 90, rationale: 'l', rationaleCode: 'latency.insufficient' },
      maintainability: { score: 90, rationale: 'm', rationaleCode: 'maintainability.summary' },
      aiRisk: { score: 90, rationale: 'a', rationaleCode: 'ai_risk.no_ai' },
    },
    ...overrides,
  }
}

describe('<WorkflowHealthBadge /> — SLO breach pill', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    useWorkflowStore.setState({ ...initialState, platformVersion: 0 }, true)
  })

  it('does not render the SLO pill when no SLO is declared', async () => {
    vi.mocked(api).mockResolvedValueOnce(makeHealth({ slo: null }))
    render(<WorkflowHealthBadge workflowId="wf-1" />)
    await waitFor(() => expect(screen.queryByLabelText(/Workflow health/i)).toBeTruthy())
    expect(screen.queryByText(/SLO breach/i)).toBeNull()
  })

  it('does not render the SLO pill when anyBreach is false', async () => {
    vi.mocked(api).mockResolvedValueOnce(
      makeHealth({
        slo: {
          slo: {
            successRatePercent: 95,
            mttrSeconds: null,
            p95DurationMs: null,
            budgetBlocksPerWindow: null,
            stuckWaitingNodesMax: null,
            windowDays: 7,
          },
          breaches: {
            successRatePercent: false,
            mttrSeconds: false,
            p95DurationMs: false,
            budgetBlocksPerWindow: false,
            stuckWaitingNodesMax: false,
            anyBreach: false,
          },
        },
      }),
    )
    render(<WorkflowHealthBadge workflowId="wf-1" />)
    await waitFor(() => expect(screen.queryByLabelText(/Workflow health/i)).toBeTruthy())
    expect(screen.queryByText(/SLO breach/i)).toBeNull()
  })

  it('renders the red SLO breach pill when anyBreach is true', async () => {
    vi.mocked(api).mockResolvedValueOnce(
      makeHealth({
        slo: {
          slo: {
            successRatePercent: 99,
            mttrSeconds: null,
            p95DurationMs: null,
            budgetBlocksPerWindow: null,
            stuckWaitingNodesMax: null,
            windowDays: 7,
          },
          breaches: {
            successRatePercent: true,
            mttrSeconds: false,
            p95DurationMs: false,
            budgetBlocksPerWindow: false,
            stuckWaitingNodesMax: false,
            anyBreach: true,
          },
        },
      }),
    )
    render(<WorkflowHealthBadge workflowId="wf-1" />)
    const pill = await screen.findByText(/SLO breach/i)
    expect(pill).toBeTruthy()
  })

  it('expands to show declared metric rows when SLO is present', async () => {
    vi.mocked(api).mockResolvedValueOnce(
      makeHealth({
        slo: {
          slo: {
            successRatePercent: 99,
            mttrSeconds: null,
            p95DurationMs: 10_000,
            budgetBlocksPerWindow: null,
            stuckWaitingNodesMax: null,
            windowDays: 14,
          },
          breaches: {
            successRatePercent: true,
            mttrSeconds: false,
            p95DurationMs: false,
            budgetBlocksPerWindow: false,
            stuckWaitingNodesMax: false,
            anyBreach: true,
          },
        },
      }),
    )
    render(<WorkflowHealthBadge workflowId="wf-1" />)
    const button = await screen.findByRole('button', { name: /Workflow health/i })
    fireEvent.click(button)
    expect(await screen.findByText(/SLO contract/i)).toBeTruthy()
    expect(screen.getByText(/Success rate %/i)).toBeTruthy()
    // null thresholds (mttr, budget, stuck) are NOT rendered.
    expect(screen.queryByText(/MTTR \(seconds\)/i)).toBeNull()
  })
})

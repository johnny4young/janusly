import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { useWorkflowStore } from '../store'
import { AlertPoliciesPanel } from './AlertPoliciesPanel'
import { RecentAlertsCard } from './RecentAlertsCard'

vi.mock('../api', () => ({
  api: vi.fn(),
}))

beforeEach(() => {
  vi.mocked(api).mockReset()
  useWorkflowStore.setState({ orgId: 'default', platformVersion: 0 })
})

describe('<AlertPoliciesPanel />', () => {
  it('renders the empty state when no policies exist', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/alerts/policies') return { policies: [] }
      if (path === '/credentials') return []
      return null
    })

    render(<AlertPoliciesPanel />)

    await waitFor(() => {
      expect(
        screen.getByText(/No alert policies yet/i),
      ).toBeInTheDocument()
    })
  })

  it('renders a populated list of policies with trigger pill + cooldown hint', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/alerts/policies') {
        return {
          policies: [
            {
              id: 'p1',
              name: 'DLQ alarm',
              trigger: 'dlq.entry_created',
              parameters: {},
              channels: [{ destination: 'slack', credentialName: 'Ops Slack' }],
              cooldownSeconds: 600,
              enabled: true,
            },
          ],
        }
      }
      if (path === '/credentials') return []
      return null
    })

    render(<AlertPoliciesPanel />)

    await waitFor(() => {
      expect(screen.getByText('DLQ alarm')).toBeInTheDocument()
    })
    expect(screen.getByText('DLQ entry created')).toBeInTheDocument()
    expect(screen.getByText(/Cooldown 600s/)).toBeInTheDocument()
  })

  it('hides the system-only rate limiter trigger for tenant orgs', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/alerts/policies') return { policies: [] }
      if (path === '/credentials') return []
      return null
    })

    render(<AlertPoliciesPanel />)

    fireEvent.click(await screen.findByRole('button', { name: /New policy/i }))
    const triggerSelect = screen.getByLabelText('Trigger')

    expect(
      within(triggerSelect).queryByRole('option', { name: /Rate limiter degraded/i }),
    ).not.toBeInTheDocument()
  })

  it('exposes the schedule-anomaly trigger with a workflow-ids filter input', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/alerts/policies') return { policies: [] }
      if (path === '/credentials') return []
      return null
    })

    render(<AlertPoliciesPanel />)

    fireEvent.click(await screen.findByRole('button', { name: /New policy/i }))
    const triggerSelect = screen.getByLabelText('Trigger')
    expect(
      within(triggerSelect).getByRole('option', { name: 'Schedule anomaly' }),
    ).toBeInTheDocument()

    // Selecting it reveals the workflow-ids allowlist input.
    fireEvent.change(triggerSelect, { target: { value: 'workflow.schedule_anomaly' } })
    expect(screen.getByLabelText(/Workflow ids/i)).toBeInTheDocument()
  })

  it('flags an out-of-range cooldown inline and gates save', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === '/alerts/policies') return { policies: [] }
      if (path === '/credentials') return []
      return null
    })

    render(<AlertPoliciesPanel />)
    fireEvent.click(await screen.findByRole('button', { name: /New policy/i }))

    // Name filled so the gate isolates the cooldown range check.
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My alert' } })
    const cooldown = screen.getByLabelText('Cooldown seconds')
    const save = within(screen.getByTestId('alert-policy-form')).getByRole('button', { name: /Save policy/i })

    fireEvent.change(cooldown, { target: { value: '10' } }) // below the 60s floor
    expect(screen.getByText(/between 60 and 86400/i)).toBeInTheDocument()
    expect(cooldown).toHaveAttribute('aria-invalid', 'true')
    expect(save).toBeDisabled()

    fireEvent.change(cooldown, { target: { value: '600' } })
    expect(screen.queryByText(/between 60 and 86400/i)).not.toBeInTheDocument()
    expect(save).toBeEnabled()
  })
})

describe('<RecentAlertsCard />', () => {
  it('renders the empty state when no dispatches exist', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path.startsWith('/alerts/recent')) return { items: [], cursor: null, hasMore: false }
      return null
    })

    render(<RecentAlertsCard />)

    await waitFor(() => {
      expect(screen.getByTestId('recent-alerts-empty')).toBeInTheDocument()
    })
  })

  it('renders delivered + delivery_failed rows with distinct severity classes', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path.startsWith('/alerts/recent')) {
        return {
          items: [
            {
              id: 'd1',
              policyId: 'p1',
              policyName: 'DLQ alarm',
              trigger: 'dlq.entry_created',
              outcome: 'delivered',
              dispatchedAt: new Date().toISOString(),
              channelResults: [
                {
                  destination: 'slack',
                  credentialName: 'Ops Slack',
                  ok: true,
                  statusCode: 200,
                  latencyMs: 120,
                },
              ],
              triggerPayload: { runId: 'r_1' },
            },
            {
              id: 'd2',
              policyId: 'p1',
              policyName: 'DLQ alarm',
              trigger: 'dlq.entry_created',
              outcome: 'delivery_failed',
              dispatchedAt: new Date().toISOString(),
              channelResults: [
                {
                  destination: 'webhook',
                  credentialName: 'self webhook',
                  ok: false,
                  statusCode: 500,
                  error: 'upstream timeout',
                  latencyMs: 5_000,
                },
              ],
              triggerPayload: { runId: 'r_2' },
            },
          ],
          cursor: null,
          hasMore: false,
        }
      }
      return null
    })

    render(<RecentAlertsCard />)

    await waitFor(() => {
      const rows = screen.getAllByTestId('recent-alert-row')
      expect(rows).toHaveLength(2)
      expect(rows[0]).toHaveAttribute('data-outcome', 'delivered')
      expect(rows[1]).toHaveAttribute('data-outcome', 'delivery_failed')
    })
    expect(screen.getAllByText('DLQ alarm')).toHaveLength(2)
    expect(screen.getByText('Delivered')).toBeInTheDocument()
    expect(screen.getByText('Delivery failed')).toBeInTheDocument()
  })
})

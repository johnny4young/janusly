import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { FailureClustersCard } from './FailureClustersCard'

vi.mock('../api', () => ({
  api: vi.fn(),
}))

describe('<FailureClustersCard />', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
  })

  it('renders cluster rows and expands workflow details', async () => {
    vi.mocked(api).mockResolvedValueOnce({
      totalSamples: 2,
      windowDays: 30,
      clusters: [{
        signature: 'HTTP 401 on http node',
        category: 'http_error',
        frequency: 2,
        affectedWorkflows: [{ workflowId: 'wf-billing', workflowName: 'Billing Flow', count: 2 }],
        firstSeen: '2026-01-01T10:00:00.000Z',
        lastSeen: '2026-01-01T11:00:00.000Z',
        suggestedOwner: 'workflow_author',
        samples: [{ source: 'dead_letter', id: 'dlq-1', runId: 'run-1234567890abcdef' }],
      }],
    })

    render(<FailureClustersCard />)

    const row = await screen.findByRole('button', { name: /HTTP 401 on http node/i })
    expect(screen.getByText('1 pattern')).toBeInTheDocument()
    expect(screen.getByText('Workflow author')).toBeInTheDocument()

    fireEvent.click(row)

    expect(screen.getByText('Billing Flow')).toBeInTheDocument()
    expect(screen.getByText('run-12345678…')).toBeInTheDocument()
  })

  it('renders an empty state when no clusters are returned', async () => {
    vi.mocked(api).mockResolvedValueOnce({ clusters: [], totalSamples: 0, windowDays: 7 })

    render(<FailureClustersCard />)

    expect(await screen.findByText('No recurring failures in the last 7 days.')).toBeInTheDocument()
  })

  it('renders an error state when the cluster endpoint fails', async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error('service down'))

    render(<FailureClustersCard />)

    await waitFor(() => {
      expect(screen.getByText(/Cluster rollup unavailable — service down/i)).toBeInTheDocument()
    })
  })
})

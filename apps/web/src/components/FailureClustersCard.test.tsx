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

  it('caps the samples list to the first 50 with a show-more toggle when a cluster has more', async () => {
    // Use short padded ids so the first-12-char slice the component
    // renders (`runId.slice(0, 12)`) still distinguishes samples.
    // Example index 1 → "run-00000001-x", sliced to "run-00000001".
    const samples = Array.from({ length: 75 }, (_, i) => ({
      source: 'dead_letter' as const,
      id: `dlq-${i + 1}`,
      runId: `run-${String(i + 1).padStart(8, '0')}-x`,
    }))
    vi.mocked(api).mockResolvedValueOnce({
      totalSamples: 75,
      windowDays: 30,
      clusters: [{
        signature: 'HTTP 401 on http node',
        category: 'http_error',
        frequency: 75,
        affectedWorkflows: [{ workflowId: 'wf', workflowName: 'Flow', count: 75 }],
        firstSeen: '2026-01-01T10:00:00.000Z',
        lastSeen: '2026-01-01T11:00:00.000Z',
        suggestedOwner: 'workflow_author',
        samples,
      }],
    })

    render(<FailureClustersCard />)

    // Expand the cluster so the samples list is in the DOM.
    fireEvent.click(await screen.findByRole('button', { name: /HTTP 401 on http node/i }))

    // First 50 samples render; the 51st is NOT in the DOM yet.
    expect(screen.getByText('run-00000001…')).toBeInTheDocument()
    expect(screen.getByText('run-00000050…')).toBeInTheDocument()
    expect(screen.queryByText('run-00000051…')).toBeNull()

    // The toggle reveals the rest. Label includes the remaining count.
    const toggle = screen.getByTestId('cluster-samples-toggle-HTTP 401 on http node')
    expect(toggle).toHaveTextContent(/25/)
    fireEvent.click(toggle)

    expect(screen.getByText('run-00000051…')).toBeInTheDocument()
    expect(screen.getByText('run-00000075…')).toBeInTheDocument()
    // Label flips to "Show fewer".
    expect(screen.getByTestId('cluster-samples-toggle-HTTP 401 on http node')).toHaveTextContent(/fewer/i)
  })

  it('falls back to a still-open DLQ member when the representative is stale', async () => {
    const staleDlq = {
      id: 'dlq-stale',
      runId: 'run-stale-1234567890',
      nodeId: 'fetch',
      attempt: 1,
      status: 'replayed',
      workflowJson: { dslVersion: '1.0', nodes: [{ id: 'fetch', type: 'http', config: { url: 'https://x' } }], edges: [] },
      nodeJson: { id: 'fetch', type: 'http', config: { url: 'https://x' } },
      errorJson: { message: 'already replayed' },
    }
    const openDlq = {
      ...staleDlq,
      id: 'dlq-open',
      runId: 'run-open-1234567890',
      status: 'open',
      errorJson: { message: 'still open' },
    }
    vi.mocked(api)
      .mockResolvedValueOnce({
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
          samples: [{ source: 'dead_letter', id: 'dlq-stale', runId: 'run-stale-1234567890' }],
        }],
      })
      .mockResolvedValueOnce({ deadLetterIds: ['dlq-open'], total: 1, capped: false })
      .mockResolvedValueOnce(staleDlq)
      .mockResolvedValueOnce(openDlq)

    render(<FailureClustersCard />)

    fireEvent.click(await screen.findByRole('button', { name: /HTTP 401 on http node/i }))
    fireEvent.click(screen.getByRole('button', { name: /Recover this pattern/i }))

    expect(await screen.findByText(/Recover fetch on run run-open/i)).toBeInTheDocument()
    expect(vi.mocked(api).mock.calls.map((call) => call[0])).toContain('/dlq?id=dlq-open')
  })
})

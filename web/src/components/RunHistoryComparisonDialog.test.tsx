import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { RunHistoryComparisonDialog } from './RunHistoryComparisonDialog'

vi.mock('../api', () => ({ api: vi.fn() }))

const selectedRun = {
  id: 'failed-run',
  workflowId: 'wf-billing',
  workflowVersionId: 'version-2',
  status: 'failed',
  createdAt: '2026-07-12T12:00:00.000Z',
}

const baselineRun = {
  id: 'green-run',
  workflowId: 'wf-billing',
  workflowVersionId: 'version-1',
  status: 'succeeded',
  createdAt: '2026-07-11T12:00:00.000Z',
}

const comparison = {
  baseRun: { id: 'green-run', status: 'succeeded', replayMode: null, parentRunId: null, createdAt: baselineRun.createdAt },
  replayRun: { id: 'failed-run', status: 'failed', replayMode: null, parentRunId: null, createdAt: selectedRun.createdAt },
  perNode: [{
    nodeId: 'fetch_invoice',
    base: { status: 'succeeded', latencyMs: 100, costUsd: null, tokens: 0, output: { ok: true }, errorJson: null },
    replay: { status: 'failed', latencyMs: 250, costUsd: null, tokens: 0, output: null, errorJson: { message: 'HTTP 500' } },
  }],
}

beforeEach(() => {
  vi.mocked(api).mockReset()
})

describe('<RunHistoryComparisonDialog />', () => {
  it('uses a strict before cursor, then compares prior green → selected failure', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce([baselineRun])
      .mockResolvedValueOnce(comparison)

    render(
      <RunHistoryComparisonDialog
        selectedRun={selectedRun}
        workflowLabel="Billing recovery"
        onClose={vi.fn()}
      />,
    )

    expect(await screen.findByTestId('comparison-row-fetch_invoice')).toBeInTheDocument()
    const baselineCall = new URL(String(vi.mocked(api).mock.calls[0]?.[0]), 'http://janusly.test')
    expect(baselineCall.pathname).toBe('/runs')
    expect(baselineCall.searchParams.get('workflowId')).toBe('wf-billing')
    expect(baselineCall.searchParams.get('status')).toBe('succeeded')
    expect(baselineCall.searchParams.get('runKind')).toBe('production')
    expect(baselineCall.searchParams.get('before')).toBe(`${selectedRun.createdAt}|${selectedRun.id}`)
    expect(baselineCall.searchParams.get('limit')).toBe('1')
    expect(vi.mocked(api).mock.calls[1]?.[0]).toBe('/runs/compare?baseRunId=green-run&replayRunId=failed-run')
    expect(screen.getByRole('columnheader', { name: 'Last successful' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Selected run' })).toBeInTheDocument()
    expect(screen.getByText('Selected run Needs attention')).toBeInTheDocument()
  })

  it('explains when retained history has no prior successful run', async () => {
    vi.mocked(api).mockResolvedValueOnce([])

    render(
      <RunHistoryComparisonDialog
        selectedRun={selectedRun}
        workflowLabel="Billing recovery"
        onClose={vi.fn()}
      />,
    )

    expect(await screen.findByText('No earlier successful run')).toBeInTheDocument()
    expect(screen.getByText(/Billing recovery has no successful run before/i)).toBeInTheDocument()
    expect(api).toHaveBeenCalledTimes(1)
  })

  it('surfaces a retryable localized error', async () => {
    vi.mocked(api)
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce([])

    render(
      <RunHistoryComparisonDialog
        selectedRun={selectedRun}
        workflowLabel="Billing recovery"
        onClose={vi.fn()}
      />,
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the historical comparison.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(api).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('No earlier successful run')).toBeInTheDocument()
  })

  it('closes from the keyboard with Escape', () => {
    vi.mocked(api).mockResolvedValueOnce([])
    const onClose = vi.fn()

    render(
      <RunHistoryComparisonDialog
        selectedRun={selectedRun}
        workflowLabel="Billing recovery"
        onClose={onClose}
      />,
    )

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

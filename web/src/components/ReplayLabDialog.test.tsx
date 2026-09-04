import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { ReplayLabDialog } from './ReplayLabDialog'

vi.mock('../api', () => {
  const module = ({
  api: vi.fn(),
})
  return {
    ...module,
    // Typed reads route through contractApi; delegate to the same mock so the
    // path-keyed expectations below keep working.
    contractApi: (_operation: string, path: string, _request: unknown, options?: RequestInit) =>
      options === undefined ? module.api(path) : module.api(path, options),
  }
})

vi.mock('../store', () => ({
  useWorkflowStore: (selector: (state: { bumpPlatformVersion: () => void }) => unknown) =>
    selector({ bumpPlatformVersion: vi.fn() }),
}))

const sourceRun = {
  id: 'src-run-id',
  status: 'failed',
  createdAt: '2026-05-12T00:00:00.000Z',
}

const replayResponse = { runId: 'replay-run-id' }
const succeededRun = {
  run: { id: 'replay-run-id', status: 'succeeded' },
  nodes: [],
  events: [],
}
const failedRun = {
  run: { id: 'replay-run-id', status: 'failed' },
  nodes: [],
  events: [],
}
const emptyComparison = {
  baseRun: { id: 'src-run-id', status: 'failed', replayMode: null, parentRunId: null, createdAt: null },
  replayRun: { id: 'replay-run-id', status: 'succeeded', replayMode: 'validation', parentRunId: 'src-run-id', createdAt: null },
  perNode: [],
}

describe('<ReplayLabDialog />', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    vi.useRealTimers()
  })

  it('renders idle state with source run details and a Start replay CTA', () => {
    render(<ReplayLabDialog sourceRun={sourceRun} onClose={vi.fn()} />)
    expect(screen.getByRole('heading', { name: /Sandbox replay/i })).toBeInTheDocument()
    expect(screen.getByText('src-run-id')).toBeInTheDocument()
    expect(screen.getByTestId('replay-lab-start')).toBeEnabled()
  })

  it('chains POST /runs/replay-lab → poll → GET /runs/compare → render done', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce(replayResponse)
      .mockResolvedValueOnce(succeededRun)
      .mockResolvedValueOnce(emptyComparison)

    render(<ReplayLabDialog sourceRun={sourceRun} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('replay-lab-start'))

    await waitFor(() => {
      expect(screen.getByTestId('replay-lab-close-done')).toBeInTheDocument()
    })

    const calls = vi.mocked(api).mock.calls.map((call) => call[0])
    expect(calls[0]).toBe('/runs/replay-lab')
    expect(calls[1]).toContain('/run?runId=replay-run-id')
    expect(calls[2]).toContain('/runs/compare')
    expect(calls[2]).toContain('baseRunId=src-run-id')
    expect(calls[2]).toContain('replayRunId=replay-run-id')
  })

  it('renders the comparison empty-state when the lab completes with no nodes', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce(replayResponse)
      .mockResolvedValueOnce(succeededRun)
      .mockResolvedValueOnce(emptyComparison)

    render(<ReplayLabDialog sourceRun={sourceRun} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('replay-lab-start'))

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/no nodes ran/i)
    })
  })

  it('surfaces an error envelope when the start request throws', async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error('Rate limit exceeded'))

    render(<ReplayLabDialog sourceRun={sourceRun} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('replay-lab-start'))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Rate limit exceeded')
    })
    expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument()
  })

  it('still renders the comparison view when the replay terminated as failed', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce(replayResponse)
      .mockResolvedValueOnce(failedRun)
      .mockResolvedValueOnce({
        ...emptyComparison,
        replayRun: { ...emptyComparison.replayRun, status: 'failed' },
      })

    render(<ReplayLabDialog sourceRun={sourceRun} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('replay-lab-start'))

    await waitFor(() => {
      expect(screen.getByTestId('replay-lab-close-done')).toBeInTheDocument()
    })
  })
})

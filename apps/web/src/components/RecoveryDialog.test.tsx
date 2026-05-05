import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { RecoveryDialog } from './RecoveryDialog'
import type { DeadLetter } from './DeadLettersPanel'

vi.mock('../api', () => ({
  api: vi.fn(),
}))

const baseDlq: DeadLetter = {
  id: 'dlq-1',
  runId: 'run-abc12345',
  nodeId: 'fetch',
  attempt: 3,
  status: 'open',
  workflowJson: {
    dslVersion: '1.0',
    nodes: [{ id: 'fetch', type: 'http', config: { url: 'https://x' } }],
    edges: [],
  },
  nodeJson: { id: 'fetch', type: 'http', config: { url: 'https://x' } },
  errorJson: { message: 'ECONNRESET' },
}

describe('<RecoveryDialog />', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
  })

  it('renders the idle step with a Generate suggestion button', () => {
    render(<RecoveryDialog dlq={baseDlq} onClose={vi.fn()} />)
    expect(screen.getByRole('heading', { name: /Recover fetch on run/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Generate suggestion/i })).toBeInTheDocument()
  })

  it('shows the diff after a suggestion arrives', async () => {
    vi.mocked(api).mockResolvedValueOnce({
      mode: 'ai',
      suggestedWorkflow: {
        dslVersion: '1.0',
        nodes: [{ id: 'fetch', type: 'http', config: { url: 'https://x', retry: { maxAttempts: 3 } } }],
        edges: [],
      },
      rationale: 'Added retry to handle transient ECONNRESET.',
    })
    render(<RecoveryDialog dlq={baseDlq} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Generate suggestion/i }))
    await waitFor(() => {
      expect(screen.getByText(/Added retry to handle/i)).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /Apply.*replay/i })).toBeInTheDocument()
  })

  it('chains save + replay on Apply, then surfaces the run id', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({
        mode: 'ai',
        suggestedWorkflow: { dslVersion: '1.0', nodes: [{ id: 'fetch', type: 'http', config: { url: 'https://x', retry: { maxAttempts: 3 } } }], edges: [] },
        rationale: 'retry added',
      })
      .mockResolvedValueOnce({ workflowId: 'wf', versionId: 'v1', version: 2 }) // /workflows/save
      .mockResolvedValueOnce({ runId: 'run-replay-xyz' })                          // /dlq/replay

    render(<RecoveryDialog dlq={baseDlq} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Generate suggestion/i }))
    await waitFor(() => screen.getByRole('button', { name: /Apply.*replay/i }))
    fireEvent.click(screen.getByRole('button', { name: /Apply.*replay/i }))

    await waitFor(() => {
      expect(screen.getByText(/Patch applied/i)).toBeInTheDocument()
    })
    expect(screen.getByText(/run-repl/i)).toBeInTheDocument()
    expect(vi.mocked(api).mock.calls.map((call) => call[0])).toEqual([
      '/ai/patch-workflow',
      '/workflows/save',
      '/dlq/replay',
    ])
  })

  it('disables Apply when the suggestion is fallback mode', async () => {
    vi.mocked(api).mockResolvedValueOnce({
      mode: 'fallback',
      suggestedWorkflow: baseDlq.workflowJson,
      rationale: 'AI is unavailable right now.',
      aiError: 'no_llm_configured',
    })
    render(<RecoveryDialog dlq={baseDlq} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Generate suggestion/i }))
    await waitFor(() => screen.getByText(/AI was unavailable/i))
    const applyButton = screen.getByRole('button', { name: /Apply.*replay/i })
    expect(applyButton).toBeDisabled()
  })
})

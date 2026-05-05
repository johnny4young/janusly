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

const aiSuggestion = {
  mode: 'ai' as const,
  suggestedWorkflow: {
    dslVersion: '1.0' as const,
    nodes: [{ id: 'fetch', type: 'http' as const, config: { url: 'https://x', retry: { maxAttempts: 3 } } }],
    edges: [],
  },
  rationale: 'Added retry to handle transient ECONNRESET.',
}

describe('<RecoveryDialog />', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    vi.useRealTimers()
  })

  it('renders the idle step with a Generate suggestion button', () => {
    render(<RecoveryDialog dlq={baseDlq} onClose={vi.fn()} />)
    expect(screen.getByRole('heading', { name: /Recover fetch on run/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Generate suggestion/i })).toBeInTheDocument()
  })

  it('shows the diff after a suggestion arrives, with the Apply & validate primary button', async () => {
    vi.mocked(api).mockResolvedValueOnce(aiSuggestion)
    render(<RecoveryDialog dlq={baseDlq} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Generate suggestion/i }))
    await waitFor(() => {
      expect(screen.getByText(/Added retry to handle/i)).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /Apply.*validate/i })).toBeInTheDocument()
  })

  it('runs validate-fix → poll → save → replay in order on Apply', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce(aiSuggestion)
      // /dlq/validate-fix
      .mockResolvedValueOnce({ runId: 'val-run-1' })
      // GET /run?runId=val-run-1 — first poll: validation succeeded
      .mockResolvedValueOnce({
        run: { id: 'val-run-1', status: 'succeeded' },
        nodes: [{ nodeId: 'fetch', status: 'succeeded' }],
      })
      // /workflows/save
      .mockResolvedValueOnce({ workflowId: 'wf', versionId: 'v1', version: 2 })
      // /dlq/replay (production)
      .mockResolvedValueOnce({ runId: 'run-replay-xyz' })

    render(<RecoveryDialog dlq={baseDlq} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Generate suggestion/i }))
    await waitFor(() => screen.getByRole('button', { name: /Apply.*validate/i }))
    fireEvent.click(screen.getByRole('button', { name: /Apply.*validate/i }))

    await waitFor(() => {
      expect(screen.getByText(/Patch applied/i)).toBeInTheDocument()
    }, { timeout: 4000 })
    expect(screen.getByText(/run-repl/i)).toBeInTheDocument()
    const calls = vi.mocked(api).mock.calls.map((call) => call[0])
    expect(calls).toContain('/ai/patch-workflow')
    expect(calls).toContain('/dlq/validate-fix')
    expect(calls.some((path) => typeof path === 'string' && path.startsWith('/run?runId=val-run-1'))).toBe(true)
    expect(calls).toContain('/workflows/save')
    expect(calls).toContain('/dlq/replay')
    // Order: suggestion → validate-fix → poll → save → replay.
    const validateIdx = calls.indexOf('/dlq/validate-fix')
    const pollIdx = calls.findIndex((path) => typeof path === 'string' && path.startsWith('/run?runId=val-run-1'))
    const saveIdx = calls.indexOf('/workflows/save')
    const replayIdx = calls.indexOf('/dlq/replay')
    expect(validateIdx).toBeLessThan(pollIdx)
    expect(pollIdx).toBeLessThan(saveIdx)
    expect(saveIdx).toBeLessThan(replayIdx)
  })

  it('surfaces validation failure with an Iterate button instead of applying', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce(aiSuggestion)
      .mockResolvedValueOnce({ runId: 'val-run-2' })
      .mockResolvedValueOnce({
        run: { id: 'val-run-2', status: 'failed' },
        nodes: [{ nodeId: 'fetch', status: 'failed', errorJson: { message: 'still 502 after retry' } }],
      })

    render(<RecoveryDialog dlq={baseDlq} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Generate suggestion/i }))
    await waitFor(() => screen.getByRole('button', { name: /Apply.*validate/i }))
    fireEvent.click(screen.getByRole('button', { name: /Apply.*validate/i }))

    await waitFor(() => {
      expect(screen.getByText(/Sandbox replay failed/i)).toBeInTheDocument()
    }, { timeout: 4000 })
    expect(screen.getByText(/still 502 after retry/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Iterate/i })).toBeInTheDocument()
    // Save + replay must NOT have been invoked when validation fails.
    const calls = vi.mocked(api).mock.calls.map((call) => call[0])
    expect(calls).not.toContain('/workflows/save')
    expect(calls).not.toContain('/dlq/replay')
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
    const applyButton = screen.getByRole('button', { name: /Apply.*validate/i })
    expect(applyButton).toBeDisabled()
  })

  it('disables Apply when an AI suggestion has no structural workflow changes', async () => {
    vi.mocked(api).mockResolvedValueOnce({
      mode: 'ai',
      suggestedWorkflow: baseDlq.workflowJson,
      rationale: 'Raise the timeout in the Inspector before replaying.',
    })

    render(<RecoveryDialog dlq={baseDlq} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Generate suggestion/i }))

    await waitFor(() => screen.getByText(/No structural patch/i))
    const applyButton = screen.getByRole('button', { name: /Apply.*validate/i })
    expect(applyButton).toBeDisabled()
  })
})

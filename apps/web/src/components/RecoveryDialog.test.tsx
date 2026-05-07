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
      // /workflows/health/delta — the delta card fetches this on mount.
      // Return a "gathering data" shape so the card renders without
      // depending on the fuller delta-math branches.
      .mockResolvedValueOnce({
        workflowId: 'wf',
        afterVersion: 2,
        windowDays: 1,
        hasEnoughData: false,
        before: { score: 80, status: 'healthy', signals: { p95LatencyMs: null, totalRuns: 0, totalCostUsd: 0 } },
        after: { score: 80, status: 'healthy', signals: { p95LatencyMs: null, totalRuns: 1, totalCostUsd: 0 } },
        delta: null,
        recentRunsAgainstAfter: { totalRuns: 1, succeeded: 1, failed: 0, running: 0 },
        sameFailureSinceApply: { count: 0, sampleDeadLetterIds: [], priorSignature: 'Network timeout on http node' },
        priorVersion: { version: 1, versionId: 'v0' },
      })

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

    // Delta card mounts after replay with the saved version + DLQ's
    // failure signature threaded in. The card calls /workflows/health/delta
    // and surfaces the run-status counter even when hasEnoughData=false.
    const deltaCall = calls.find((path) => typeof path === 'string' && path.startsWith('/workflows/health/delta'))
    expect(deltaCall).toBeTruthy()
    if (typeof deltaCall === 'string') {
      const url = new URL(deltaCall, 'http://localhost')
      expect(url.searchParams.get('workflowId')).toBe('wf')
      expect(url.searchParams.get('afterVersion')).toBe('2')
      // The DLQ has errorJson `{ message: 'ECONNRESET' }` and
      // nodeJson.type = 'http', so the normalizer produces this signature.
      expect(url.searchParams.get('priorFailureSignature')).toBe('Network timeout on http node')
    }
    await waitFor(() => {
      expect(screen.getByTestId('recovery-delta-counter')).toBeInTheDocument()
    })
    expect(screen.getAllByText(/Runs against v2/i).length).toBeGreaterThan(0)
    expect(screen.getByTestId('recovery-delta-same-failure')).toBeInTheDocument()
    expect(screen.getAllByText(/of 5 runs collected/i).length).toBeGreaterThan(0)
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

  describe('multi-suggestion tabs', () => {
    const fetchUrl = (url: string) => ({
      dslVersion: '1.0' as const,
      nodes: [{ id: 'fetch', type: 'http' as const, config: { url } }],
      edges: [],
    })

    const threeSuggestionResponse = {
      mode: 'ai' as const,
      // Back-compat mirror — point at the highest-confidence suggestion.
      suggestedWorkflow: {
        dslVersion: '1.0' as const,
        nodes: [{ id: 'fetch', type: 'http' as const, config: { url: 'https://x', retry: { maxAttempts: 3 } } }],
        edges: [],
      },
      rationale: 'Added retry to handle transient ECONNRESET.',
      suggestions: [
        {
          workflow: {
            dslVersion: '1.0' as const,
            nodes: [{ id: 'fetch', type: 'http' as const, config: { url: 'https://x', retry: { maxAttempts: 3 } } }],
            edges: [],
          },
          rationale: 'Added retry to handle transient ECONNRESET.',
          approachLabel: 'add_retry' as const,
          confidence: 85,
        },
        {
          workflow: {
            dslVersion: '1.0' as const,
            nodes: [{ id: 'fetch', type: 'http' as const, config: { url: 'https://x', timeoutMs: 60_000 } }],
            edges: [],
          },
          rationale: 'Or raise the timeout if upstream is just slow.',
          approachLabel: 'raise_timeout' as const,
          confidence: 65,
        },
        {
          workflow: fetchUrl('https://x.example/fixed'),
          rationale: 'Or fix the typo in the URL.',
          approachLabel: 'fix_url' as const,
          confidence: 40,
        },
      ],
    }

    it('renders one tab per suggestion when length > 1, with the highest-confidence default-selected', async () => {
      vi.mocked(api).mockResolvedValueOnce(threeSuggestionResponse)
      render(<RecoveryDialog dlq={baseDlq} onClose={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: /Generate suggestion/i }))

      await waitFor(() => screen.getByRole('tab', { name: /Add retry.*85/i }))
      expect(screen.getByRole('tab', { name: /Add retry.*85/i })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByRole('tab', { name: /Raise timeout.*65/i })).toHaveAttribute('aria-selected', 'false')
      expect(screen.getByRole('tab', { name: /Fix URL.*40/i })).toHaveAttribute('aria-selected', 'false')
      // Default rationale shown is the highest-confidence one.
      expect(screen.getByText(/Added retry to handle transient/i)).toBeInTheDocument()
    })

    it('clicking a different tab swaps the rendered diff and rationale', async () => {
      vi.mocked(api).mockResolvedValueOnce(threeSuggestionResponse)
      render(<RecoveryDialog dlq={baseDlq} onClose={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: /Generate suggestion/i }))

      await waitFor(() => screen.getByRole('tab', { name: /Add retry.*85/i }))
      fireEvent.click(screen.getByRole('tab', { name: /Raise timeout.*65/i }))

      // The newly-active tab now claims aria-selected, and the diff +
      // rationale come from the second suggestion.
      expect(screen.getByRole('tab', { name: /Raise timeout.*65/i })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByText(/raise the timeout/i)).toBeInTheDocument()
    })

    it('supports keyboard navigation across suggestion tabs', async () => {
      vi.mocked(api).mockResolvedValueOnce(threeSuggestionResponse)
      render(<RecoveryDialog dlq={baseDlq} onClose={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: /Generate suggestion/i }))

      const firstTab = await screen.findByRole('tab', { name: /Add retry.*85/i })
      firstTab.focus()
      fireEvent.keyDown(firstTab, { key: 'ArrowRight' })

      expect(screen.getByRole('tab', { name: /Raise timeout.*65/i })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByText(/raise the timeout/i)).toBeInTheDocument()
    })

    it('Apply posts the SELECTED suggestion to /dlq/validate-fix', async () => {
      vi.mocked(api)
        .mockResolvedValueOnce(threeSuggestionResponse)
        // /dlq/validate-fix
        .mockResolvedValueOnce({ runId: 'val-run-tabs' })
        // GET /run poll — keep the dialog stuck in validating so we don't fall through to save
        .mockResolvedValue({ run: { id: 'val-run-tabs', status: 'queued' }, nodes: [] })

      render(<RecoveryDialog dlq={baseDlq} onClose={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: /Generate suggestion/i }))
      await waitFor(() => screen.getByRole('tab', { name: /Add retry.*85/i }))
      // Pick the second tab (raise_timeout) before applying.
      fireEvent.click(screen.getByRole('tab', { name: /Raise timeout.*65/i }))
      fireEvent.click(screen.getByRole('button', { name: /Apply.*validate/i }))

      await waitFor(() => {
        const validateCall = vi.mocked(api).mock.calls.find((call) => call[0] === '/dlq/validate-fix')
        expect(validateCall).toBeDefined()
      })
      const validateCall = vi.mocked(api).mock.calls.find((call) => call[0] === '/dlq/validate-fix')!
      const body = JSON.parse((validateCall[1] as { body: string }).body)
      expect(body.suggestedWorkflow.nodes[0].config).toMatchObject({ timeoutMs: 60_000 })
      expect(body.suggestedWorkflow.nodes[0].config.retry).toBeUndefined()
    })

    it('renders no tabs when only one suggestion is returned', async () => {
      vi.mocked(api).mockResolvedValueOnce({
        ...threeSuggestionResponse,
        suggestions: [threeSuggestionResponse.suggestions[0]],
      })
      render(<RecoveryDialog dlq={baseDlq} onClose={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: /Generate suggestion/i }))
      await waitFor(() => screen.getByText(/Added retry to handle/i))

      // No tablist mounts when the array has just one item — the UI is identical to today's single-suggestion path.
      expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    })

    it('back-compat: renders a single-suggestion review for legacy ai responses without a `suggestions` field', async () => {
      // A future cached or older-server response could omit `suggestions`.
      // The dialog's normalisePatchSuggestion shim must synthesize a single
      // item from the legacy `suggestedWorkflow` + `rationale` fields so
      // Apply stays enabled and the diff renders.
      vi.mocked(api).mockResolvedValueOnce({
        mode: 'ai',
        suggestedWorkflow: {
          dslVersion: '1.0' as const,
          nodes: [{ id: 'fetch', type: 'http' as const, config: { url: 'https://x', retry: { maxAttempts: 3 } } }],
          edges: [],
        },
        rationale: 'Legacy single-suggestion shape — Add retry.',
      })
      render(<RecoveryDialog dlq={baseDlq} onClose={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: /Generate suggestion/i }))

      await waitFor(() => screen.getByText(/Legacy single-suggestion shape/i))
      // No tabs render for a single suggestion.
      expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
      // Apply is enabled — the synthesized item carries the legacy workflow as its `workflow`.
      const applyButton = screen.getByRole('button', { name: /Apply.*validate/i })
      expect(applyButton).not.toBeDisabled()
    })

    it('a fresh suggestion request resets the selected tab back to the highest-confidence one', async () => {
      // Pin the contract: switching tabs and then asking for a NEW
      // suggestion (e.g. via the Iterate button after a sandbox failure)
      // must reset the selection to tab 0. Otherwise a stale "fix_url"
      // selection from the prior round would silently drive the next
      // Apply.
      const secondResponse = {
        ...threeSuggestionResponse,
        suggestions: threeSuggestionResponse.suggestions.map((suggestion, index) => ({
          ...suggestion,
          rationale: `${suggestion.rationale} (round 2 #${index})`,
        })),
      }
      vi.mocked(api)
        .mockResolvedValueOnce(threeSuggestionResponse)
        // /dlq/validate-fix
        .mockResolvedValueOnce({ runId: 'val-run-tabs-reset' })
        // GET /run — failed
        .mockResolvedValueOnce({
          run: { id: 'val-run-tabs-reset', status: 'failed' },
          nodes: [{ nodeId: 'fetch', status: 'failed', errorJson: { message: 'still 502' } }],
        })
        // Second suggestion request after Iterate
        .mockResolvedValueOnce(secondResponse)

      render(<RecoveryDialog dlq={baseDlq} onClose={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: /Generate suggestion/i }))
      await waitFor(() => screen.getByRole('tab', { name: /Add retry.*85/i }))

      // Pick the third tab in the first round.
      fireEvent.click(screen.getByRole('tab', { name: /Fix URL.*40/i }))
      expect(screen.getByRole('tab', { name: /Fix URL.*40/i })).toHaveAttribute('aria-selected', 'true')

      // Apply → fails → Iterate.
      fireEvent.click(screen.getByRole('button', { name: /Apply.*validate/i }))
      await waitFor(() => screen.getByText(/Sandbox replay failed/i), { timeout: 4000 })
      fireEvent.click(screen.getByRole('button', { name: /Iterate/i }))

      await waitFor(() => screen.getByText(/round 2 #0/i))
      // After the new suggestion arrives, tab 0 is selected again.
      expect(screen.getByRole('tab', { name: /Add retry.*85/i })).toHaveAttribute('aria-selected', 'true')
      expect(screen.getByRole('tab', { name: /Fix URL.*40/i })).toHaveAttribute('aria-selected', 'false')
    })
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

  describe('cluster mode', () => {
    it('calls /dlq/cluster-apply (not /dlq/replay) and surfaces "Replayed N of M"', async () => {
      vi.mocked(api)
        .mockResolvedValueOnce(aiSuggestion)
        // /dlq/validate-fix
        .mockResolvedValueOnce({ runId: 'val-run-cluster' })
        // GET /run polling — succeeded
        .mockResolvedValueOnce({
          run: { id: 'val-run-cluster', status: 'succeeded' },
          nodes: [{ nodeId: 'fetch', status: 'succeeded' }],
        })
        // /workflows/save
        .mockResolvedValueOnce({ workflowId: 'wf', versionId: 'v1', version: 2 })
        // /dlq/cluster-apply
        .mockResolvedValueOnce({ replayed: 9, failed: 1, errors: [{ deadLetterId: 'dlq-7', error: 'DLQ entry already replayed' }] })
        // /workflows/health/delta — the delta card mounts in cluster mode too.
        .mockResolvedValueOnce({
          workflowId: 'wf',
          afterVersion: 2,
          windowDays: 1,
          hasEnoughData: false,
          before: { score: 80, status: 'healthy', signals: { p95LatencyMs: null, totalRuns: 0, totalCostUsd: 0 } },
          after: { score: 80, status: 'healthy', signals: { p95LatencyMs: null, totalRuns: 0, totalCostUsd: 0 } },
          delta: null,
          recentRunsAgainstAfter: { totalRuns: 9, succeeded: 9, failed: 0, running: 0 },
          sameFailureSinceApply: { count: 0, sampleDeadLetterIds: [], priorSignature: 'Network timeout on http node' },
          priorVersion: { version: 1, versionId: 'v0' },
        })

      render(
        <RecoveryDialog
          dlq={baseDlq}
          onClose={vi.fn()}
          clusterMembers={['dlq-1', 'dlq-2', 'dlq-3', 'dlq-4', 'dlq-5', 'dlq-6', 'dlq-7', 'dlq-8', 'dlq-9', 'dlq-10']}
          clusterSignature="Missing secret: GITHUB_TOKEN"
          clusterMembersCapped
          clusterMembersTotal={24}
        />,
      )

      // Idle copy mentions both the capped batch count and total matches.
      expect(screen.getByText(/10 of 24/)).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: /Generate suggestion/i }))
      await waitFor(() => screen.getByRole('button', { name: /Apply.*validate.*10 entries/i }))
      fireEvent.click(screen.getByRole('button', { name: /Apply.*validate.*10 entries/i }))

      await waitFor(() => {
        expect(screen.getByText(/Patch applied/i)).toBeInTheDocument()
      }, { timeout: 4000 })
      expect(screen.getByText(/Replayed 9 of 10/i)).toBeInTheDocument()
      expect(screen.getByText(/1 failed/i)).toBeInTheDocument()
      expect(screen.getByText(/Show per-row errors/i)).toBeInTheDocument()

      const calls = vi.mocked(api).mock.calls.map((call) => call[0])
      expect(calls).toContain('/dlq/cluster-apply')
      expect(calls).not.toContain('/dlq/replay')

      // Verify the cluster-apply payload contains the signature + members.
      const clusterApplyCall = vi.mocked(api).mock.calls.find((call) => call[0] === '/dlq/cluster-apply')
      expect(clusterApplyCall).toBeDefined()
      const body = JSON.parse((clusterApplyCall![1] as { body: string }).body)
      expect(body.clusterSignature).toBe('Missing secret: GITHUB_TOKEN')
      expect(body.deadLetterIds).toHaveLength(10)
    })
  })
})

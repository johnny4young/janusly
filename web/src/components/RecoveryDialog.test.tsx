import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { RecoveryDialog } from './RecoveryDialog'
import type { DeadLetter } from './DeadLettersPanel'

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
// The similar-runs card owns its own suite; here it must not consume the
// dialog's mockResolvedValueOnce chains with its semantic-search fetch.
vi.mock('./recovery-dialog/SimilarRunsCard', () => ({ SimilarRunsCard: () => null }))

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

// Fallback for unmocked paths. After every test's
// `mockResolvedValueOnce` chain is consumed, the dialog's fire-and-forget
// side-effects (`/recovery/feedback`, card's `/workflows/health/delta`
// refetch on platformVersion bump, etc.) still fire. Each gets a
// path-shape-appropriate stub so consumers don't crash when accessing
// expected fields.
const inertFallback = (path: string) => {
  if (typeof path === 'string') {
    if (path.startsWith('/workflows/health/delta')) {
      return Promise.resolve({
        workflowId: 'wf',
        afterVersion: 2,
        windowDays: 1,
        hasEnoughData: false,
        before: { score: 80, status: 'healthy', signals: { p95LatencyMs: null, totalRuns: 0, totalCostUsd: 0 } },
        after: { score: 80, status: 'healthy', signals: { p95LatencyMs: null, totalRuns: 0, totalCostUsd: 0 } },
        delta: null,
        recentRunsAgainstAfter: { totalRuns: 0, succeeded: 0, failed: 0, running: 0 },
        sameFailureSinceApply: { count: 0, sampleDeadLetterIds: [], priorSignature: 'Network timeout on http node' },
        priorVersion: null,
      })
    }
  }
  return Promise.resolve({ ok: true })
}

describe('<RecoveryDialog />', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    vi.mocked(api).mockImplementation((path: string) => inertFallback(path))
    vi.useRealTimers()
  })

  it('renders the idle step with a Generate suggestion button', () => {
    render(<RecoveryDialog dlq={baseDlq} onClose={vi.fn()} />)
    expect(screen.getByRole('heading', { name: /Recover fetch on run/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Generate suggestion/i })).toBeInTheDocument()
  })

  it('shows the diff after a suggestion arrives, with the Validate in sandbox primary button', async () => {
    vi.mocked(api).mockResolvedValueOnce(aiSuggestion)
    render(<RecoveryDialog dlq={baseDlq} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Generate suggestion/i }))
    await waitFor(() => {
      expect(screen.getByText(/Added retry to handle/i)).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /Validate in sandbox/i })).toBeInTheDocument()
  })

  it('surfaces stale feedback health for the selected recovery approach', async () => {
    vi.mocked(api).mockResolvedValueOnce({
      ...aiSuggestion,
      suggestions: [{
        workflow: aiSuggestion.suggestedWorkflow,
        rationale: aiSuggestion.rationale,
        approachLabel: 'add_retry',
        confidence: 76,
      }],
      feedbackHealth: {
        windowDays: 30,
        approaches: [{
          approachLabel: 'add_retry',
          feedbackLastSeen: '2026-07-09T00:00:00.000Z',
          acceptedFixLastSeen: '2026-05-29T00:00:00.000Z',
          acceptedFixAgeDays: 42,
          state: 'stale',
        }],
      },
    })

    render(<RecoveryDialog dlq={baseDlq} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Generate suggestion/i }))

    const health = await screen.findByTestId('recovery-dialog-learning-health')
    expect(health).toHaveAttribute('data-state', 'stale')
    expect(health).toHaveTextContent('Learning paused')
    expect(health).toHaveTextContent('42 days')
  })

  it('renders the "Why this suggestion?" evidence panel with chips and scrubs secrets at read', async () => {
    vi.mocked(api).mockResolvedValueOnce({
      ...aiSuggestion,
      evidence: [
        { kind: 'signature_rule', sourceRef: 'network_timeout', snippet: 'Matched rule "network_timeout"' },
        { kind: 'memory_entry', sourceRef: 'mem-77', snippet: 'operator accepted add_retry once' },
        // Defense-in-depth: a snippet that still carries a secret shape must
        // be redacted by the render-time scrub even if the API missed it.
        { kind: 'recent_error', sourceRef: 'run-prior9', snippet: 'auth failed sk-abcdefghijklmnopqrstuvwxyz012345' },
      ],
    })
    render(<RecoveryDialog dlq={baseDlq} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Generate suggestion/i }))
    await waitFor(() => screen.getByText(/Added retry to handle/i))
    // The collapsible summary shows the source count.
    const summary = screen.getByText(/Why this suggestion\?/i)
    expect(summary).toBeInTheDocument()
    expect(summary.textContent).toMatch(/3 sources/i)
    // Each row's source-ref deep-link token renders.
    expect(screen.getByText('mem-77')).toBeInTheDocument()
    expect(screen.getByText('run-prior9')).toBeInTheDocument()
    // Kind labels render.
    expect(screen.getByText('Memory')).toBeInTheDocument()
    expect(screen.getByText('Signature rule')).toBeInTheDocument()
    // The secret never reaches the DOM — redaction at read.
    expect(screen.queryByText(/sk-abcdefghijklmnopqrstuvwxyz012345/)).not.toBeInTheDocument()
    expect(screen.getByText(/\[redacted\]/)).toBeInTheDocument()
  })

  it('hides the evidence panel entirely when evidence is empty (empty case is valid)', async () => {
    vi.mocked(api).mockResolvedValueOnce({ ...aiSuggestion, evidence: [] })
    render(<RecoveryDialog dlq={baseDlq} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Generate suggestion/i }))
    await waitFor(() => screen.getByText(/Added retry to handle/i))
    expect(screen.queryByText(/Why this suggestion\?/i)).not.toBeInTheDocument()
  })

  it('turns an evidenced read-side passport safe only after sandbox success', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({
        ...aiSuggestion,
        suggestions: [{
          workflow: aiSuggestion.suggestedWorkflow,
          rationale: aiSuggestion.rationale,
          approachLabel: 'add_retry',
          confidence: 99,
          safety: { writeSide: false, approvalRequired: false, approvalPresent: true },
        }],
        evidence: [{ kind: 'signature_rule', sourceRef: 'network_timeout', snippet: 'Matched network timeout' }],
        recoveryPassport: {
          failureSignature: 'Network timeout on http node',
          priorSameSignatureOutcome: {
            status: 'applied',
            approachLabel: 'add_retry',
            declineReason: null,
            occurredAt: '2026-07-01T00:00:00.000Z',
          },
        },
      })
      .mockResolvedValueOnce({ runId: 'val-passport' })
      .mockResolvedValueOnce({
        run: { id: 'val-passport', status: 'succeeded' },
        nodes: [{ nodeId: 'fetch', status: 'succeeded' }],
      })

    render(<RecoveryDialog dlq={{
      ...baseDlq,
      recovery: {
        id: 'ri-1', owner: null, severity: 'p2', status: 'open', slaTargetAt: '2026-07-12T00:00:00.000Z',
        resolutionReason: null, comments: [], workflowId: null, metadataWorkflowId: null,
        occurrenceCount: 4, lastOccurredAt: '2026-07-11T00:00:00.000Z',
      },
      suspectVersion: {
        workflowId: 'wf', versionId: 'v2', version: 2, previousVersion: 1, previousVersionId: 'v1',
        savedAt: '2026-07-10T00:00:00.000Z',
        dagJson: baseDlq.workflowJson as never, previousDagJson: baseDlq.workflowJson as never,
      },
    }} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Generate suggestion/i }))

    const passport = await screen.findByTestId('recovery-confidence-passport')
    expect(passport).toHaveAttribute('data-verdict', 'needs_review')
    expect(passport).toHaveTextContent('4 occurrences')
    expect(passport).toHaveTextContent('Version 2')
    expect(passport).toHaveTextContent('99% confidence · informational only')

    fireEvent.click(screen.getByRole('button', { name: /Validate in sandbox/i }))
    await waitFor(() => expect(screen.getByTestId('recovery-confidence-passport')).toHaveAttribute('data-verdict', 'safe_to_apply'))
    expect(screen.getByText(/Apply validated fix/i)).toBeInTheDocument()
    expect(vi.mocked(api).mock.calls.map((call) => call[0])).not.toContain('/workflows/save')
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
    await waitFor(() => screen.getByRole('button', { name: /Validate in sandbox/i }))
    fireEvent.click(screen.getByRole('button', { name: /Validate in sandbox/i }))

    const applyButton = await screen.findByRole('button', { name: /Apply validated fix/i })
    expect(vi.mocked(api).mock.calls.map((call) => call[0])).not.toContain('/workflows/save')
    expect(screen.getByTestId('recovery-confidence-passport')).toHaveAttribute('data-verdict', 'needs_review')
    fireEvent.click(applyButton)

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
    let deltaCall: unknown
    await waitFor(() => {
      deltaCall = vi.mocked(api).mock.calls
        .map((call) => call[0])
        .find((path) => typeof path === 'string' && path.startsWith('/workflows/health/delta'))
      expect(deltaCall).toBeTruthy()
    })
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

    // Operator → system feedback: Apply success writes one row with
    // `accepted: true` so the next patch suggestion for THIS workflow
    // can deprioritize already-rejected approaches.
    await waitFor(() => {
      const feedbackCall = vi.mocked(api).mock.calls.find((entry) => entry[0] === '/recovery/feedback')
      expect(feedbackCall).toBeTruthy()
    })
    const feedbackCall = vi.mocked(api).mock.calls.find((entry) => entry[0] === '/recovery/feedback')
    expect(feedbackCall).toBeTruthy()
    if (feedbackCall) {
      const body = JSON.parse((feedbackCall[1] as RequestInit).body as string)
      expect(body).toMatchObject({
        deadLetterId: 'dlq-1',
        accepted: true,
        suggestionMode: 'ai',
        // The aiSuggestion fixture has no explicit approachLabel and
        // normalisePatchSuggestion fills in the legacy fallback "other".
        approachLabel: 'other',
      })
    }
    // A successful, accepted recovery with a persisted source version exposes
    // manual promotion; it never creates or activates a playbook implicitly.
    expect(await screen.findByRole('button', { name: /Create playbook/i })).toBeInTheDocument()
    expect(calls.some((path) => path === '/recovery/playbooks')).toBe(false)
  })

  it('cancel-from-review opens the cancelling step; selecting a chip writes feedback with the chip text', async () => {
    vi.mocked(api).mockResolvedValueOnce(aiSuggestion)
    const onClose = vi.fn()
    render(<RecoveryDialog dlq={baseDlq} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /Generate suggestion/i }))
    await waitFor(() => screen.getByRole('button', { name: /Validate in sandbox/i }))

    // Click the review-state Cancel — should NOT close the dialog (no
    // /recovery/feedback call yet); instead enters the `cancelling` step
    // with the 5 reason chips visible.
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }))
    expect(onClose).not.toHaveBeenCalled()
    await waitFor(() => screen.getByRole('group', { name: /Quick reason/i }))

    // Click a chip → writes feedback with the chip text + closes.
    fireEvent.click(screen.getByRole('button', { name: /Wrong approach/i }))

    await waitFor(() => {
      const feedbackCall = vi.mocked(api).mock.calls.find((entry) => entry[0] === '/recovery/feedback')
      expect(feedbackCall).toBeTruthy()
    })
    const feedbackCall = vi.mocked(api).mock.calls.find((entry) => entry[0] === '/recovery/feedback')
    if (feedbackCall) {
      const body = JSON.parse((feedbackCall[1] as RequestInit).body as string)
      expect(body).toMatchObject({
        deadLetterId: 'dlq-1',
        accepted: false,
        comment: 'Wrong approach',
      })
    }
    expect(onClose).toHaveBeenCalled()
  })

  it('Iterate from validation-failed writes a feedback row with comment="validation_failed" before re-entering generate', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce(aiSuggestion)
      .mockResolvedValueOnce({ runId: 'val-run-iter' })
      .mockResolvedValueOnce({
        run: { id: 'val-run-iter', status: 'failed' },
        nodes: [{ nodeId: 'fetch', status: 'failed', errorJson: { message: 'still 502 after retry' } }],
      })
      // Iterate calls /ai/patch-workflow again — we don't care what it returns; just resolve.
      .mockResolvedValue(aiSuggestion)

    render(<RecoveryDialog dlq={baseDlq} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Generate suggestion/i }))
    await waitFor(() => screen.getByRole('button', { name: /Validate in sandbox/i }))
    fireEvent.click(screen.getByRole('button', { name: /Validate in sandbox/i }))

    await waitFor(() => screen.getByText(/Sandbox replay failed/i), { timeout: 4000 })
    fireEvent.click(screen.getByRole('button', { name: /Iterate/i }))

    await waitFor(() => {
      const feedbackCall = vi.mocked(api).mock.calls.find((entry) => entry[0] === '/recovery/feedback')
      expect(feedbackCall).toBeTruthy()
    })
    const feedbackCall = vi.mocked(api).mock.calls.find((entry) => entry[0] === '/recovery/feedback')
    if (feedbackCall) {
      const body = JSON.parse((feedbackCall[1] as RequestInit).body as string)
      expect(body).toMatchObject({
        deadLetterId: 'dlq-1',
        accepted: false,
        comment: 'validation_failed',
      })
    }
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
    await waitFor(() => screen.getByRole('button', { name: /Validate in sandbox/i }))
    fireEvent.click(screen.getByRole('button', { name: /Validate in sandbox/i }))

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
    const applyButton = screen.getByRole('button', { name: /Validate in sandbox/i })
    expect(applyButton).toBeDisabled()
    expect(screen.getByTestId('recovery-confidence-passport')).toHaveAttribute('data-verdict', 'unsafe')
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
      fireEvent.click(screen.getByRole('button', { name: /Validate in sandbox/i }))

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
      const applyButton = screen.getByRole('button', { name: /Validate in sandbox/i })
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
        // /recovery/feedback — Iterate captures the rejection BEFORE
        // re-entering generateSuggestion. Inserted into the chain
        // explicitly so the next slot is the second suggestion call.
        .mockResolvedValueOnce({ ok: true })
        // Second suggestion request after Iterate
        .mockResolvedValueOnce(secondResponse)

      render(<RecoveryDialog dlq={baseDlq} onClose={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: /Generate suggestion/i }))
      await waitFor(() => screen.getByRole('tab', { name: /Add retry.*85/i }))

      // Pick the third tab in the first round.
      fireEvent.click(screen.getByRole('tab', { name: /Fix URL.*40/i }))
      expect(screen.getByRole('tab', { name: /Fix URL.*40/i })).toHaveAttribute('aria-selected', 'true')

      // Apply → fails → Iterate.
      fireEvent.click(screen.getByRole('button', { name: /Validate in sandbox/i }))
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
    const applyButton = screen.getByRole('button', { name: /Validate in sandbox/i })
    expect(applyButton).toBeDisabled()
  })

  describe('cluster mode', () => {
    it('calls /dlq/cluster-apply (not /dlq/replay) and surfaces "Queued N of M"', async () => {
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
      await waitFor(() => screen.getByRole('button', { name: /Validate 1 sample.*10 entries/i }))
      fireEvent.click(screen.getByRole('button', { name: /Validate 1 sample.*10 entries/i }))
      fireEvent.click(await screen.findByRole('button', { name: /Apply to 10 entries/i }))

      await waitFor(() => {
        expect(screen.getByText(/Patch applied/i)).toBeInTheDocument()
      }, { timeout: 4000 })
      expect(screen.getByText(/Queued 9 of 10/i)).toBeInTheDocument()
      expect(screen.getByText(/1 could not be queued/i)).toBeInTheDocument()
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

    // Regression: the cluster line used to print the match count twice —
    // "matches 4 4 open DLQ entries" — because the <strong> and the counted
    // i18n string each rendered it. The count belongs to the <strong> alone.
    describe('idle cluster line', () => {
      // `baseDlq.attempt` is 3, so the member count is deliberately 4: a naive
      // occurrence check against 3 would pass on the "after 3 attempts" clause.
      const members = ['dlq-1', 'dlq-2', 'dlq-3', 'dlq-4']

      const clusterLine = (container: HTMLElement) => {
        const line = [...container.querySelectorAll('p.helper-text')]
          .find(node => /pattern matches/i.test(node.textContent ?? ''))
        expect(line, 'idle cluster line not rendered').toBeDefined()
        return (line!.textContent ?? '').replace(/\s+/g, ' ').trim()
      }

      it('names the match count once when the member list is complete', () => {
        const { container } = render(
          <RecoveryDialog
            dlq={baseDlq}
            onClose={vi.fn()}
            clusterMembers={members}
            clusterSignature="Network timeout on http node"
          />,
        )

        const text = clusterLine(container)
        expect(text).toMatch(/matches 4 open DLQ entries/)
        expect(text.match(/\b4\b/g)).toHaveLength(1)
      })

      it('names visible-of-total once when the member list is capped', () => {
        const { container } = render(
          <RecoveryDialog
            dlq={baseDlq}
            onClose={vi.fn()}
            clusterMembers={members}
            clusterSignature="Network timeout on http node"
            clusterMembersCapped
            clusterMembersTotal={31}
          />,
        )

        const text = clusterLine(container)
        expect(text).toMatch(/matches 4 of 31 open DLQ entries/)
        expect(text.match(/\b4\b/g)).toHaveLength(1)
        expect(text.match(/\b31\b/g)).toHaveLength(1)
      })

      // The noun agrees with the set being described, not with the slice shown:
      // one visible entry out of 31 is still "entries".
      it('pluralises against the total when capped, and against the count when not', () => {
        const capped = render(
          <RecoveryDialog
            dlq={baseDlq}
            onClose={vi.fn()}
            clusterMembers={['dlq-1']}
            clusterSignature="Network timeout on http node"
            clusterMembersCapped
            clusterMembersTotal={31}
          />,
        )
        expect(clusterLine(capped.container)).toMatch(/matches 1 of 31 open DLQ entries/)
        capped.unmount()

        const single = render(
          <RecoveryDialog
            dlq={baseDlq}
            onClose={vi.fn()}
            clusterMembers={['dlq-1']}
            clusterSignature="Network timeout on http node"
          />,
        )
        expect(clusterLine(single.container)).toMatch(/matches 1 open DLQ entry\b/)
      })
    })

    it('shows the two-step cluster progress (validate → replay N) while validating', async () => {
      vi.mocked(api)
        .mockResolvedValueOnce(aiSuggestion)
        // /dlq/validate-fix
        .mockResolvedValueOnce({ runId: 'val-run-progress' })
        // GET /run poll keeps returning running → the dialog stays in validating
        .mockResolvedValue({ run: { id: 'val-run-progress', status: 'running' }, nodes: [] })

      render(
        <RecoveryDialog
          dlq={baseDlq}
          onClose={vi.fn()}
          clusterMembers={['dlq-1', 'dlq-2', 'dlq-3']}
          clusterSignature="Network timeout on http node"
        />,
      )

      fireEvent.click(screen.getByRole('button', { name: /Generate suggestion/i }))
      await waitFor(() => screen.getByRole('button', { name: /Validate 1 sample.*3 entr/i }))
      fireEvent.click(screen.getByRole('button', { name: /Validate 1 sample.*3 entr/i }))

      const steps = await screen.findByTestId('recovery-cluster-steps')
      // Step 1 (validate) is active while validating; the replay step names the count.
      expect(steps.querySelector('li[data-state="active"]')).toHaveTextContent(/Validate/i)
      expect(steps).toHaveTextContent(/Replay 3 runs/i)
      // The cluster-aware copy sets the 1-representative expectation.
      expect(screen.getByText(/representative failure/i)).toBeInTheDocument()
    })
  })
})

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import { RecoveryDialog } from './RecoveryDialog'
import type { DeadLetter } from './DeadLettersPanel'

vi.mock('../api', async () => {
  const { contractApiOver } = await import('../test/contract-api-mock')
  const { healthDelta } = await import('../test/health-delta-fixture')
  const { patchResponse } = await import('../test/patch-response-fixture')
  const { runView, versionRows } = await import('../test/run-view-fixture')
  const api = vi.fn()
  // Typed calls reach the same path-keyed mock; partial fixtures are completed to the manifest.
  return {
    api,
    contractApi: contractApiOver(api, {
      'GET /run': runView,
      'GET /workflows/versions': versionRows,
      'GET /workflows/health/delta': healthDelta,
      'POST /ai/patch-workflow': (value: Record<string, unknown>) => patchResponse(value),
      'POST /recovery/playbooks/{id}/use': (value: { suggestion: Record<string, unknown> }) => ({ suggestion: patchResponse(value.suggestion) }),
    }),
  }
})
vi.mock('./recovery-dialog/SimilarRunsCard', () => ({ SimilarRunsCard: () => null }))

const dlq: DeadLetter = {
  id: 'dlq-focus', runId: 'run-abc12345', nodeId: 'fetch', attempt: 1, status: 'open',
  workflowJson: { dslVersion: '1.0', nodes: [{ id: 'fetch', type: 'http', config: { url: 'https://x' } }], edges: [] },
  nodeJson: { id: 'fetch', type: 'http', config: { url: 'https://x' } },
  errorJson: { message: 'ECONNRESET' },
}
const suggestion = {
  mode: 'ai',
  suggestedWorkflow: {
    dslVersion: '1.0',
    nodes: [{ id: 'fetch', type: 'http', config: { url: 'https://x', retry: { maxAttempts: 3 } } }],
    edges: [],
  },
  rationale: 'Retry the transient failure.',
}
const initialStore = useWorkflowStore.getState()

describe('<RecoveryDialog /> keyboard focus (Chromium)', () => {
  beforeEach(() => {
    useWorkflowStore.setState({ ...initialStore, identityContext: {
      identity: { userId: 'dev-user', email: null, mode: 'dev-headers', source: 'dev' },
      profile: { name: null, email: null },
      organizations: [{ id: 'default', name: 'Default', plan: null, role: 'editor', roleBase: 'editor',
        permissions: ['workflows.read', 'workflows.write'], usable: true, developmentFallback: false, isOwner: false }],
      invitations: [], currentOrganizationId: 'default', selectionRequired: false, needsOrganization: false,
      truncated: false, invitationsTruncated: false,
    } }, true)
    vi.mocked(api).mockReset()
  })

  it('keeps focus inside through generation and validation without auto-focusing Apply', async () => {
    let releaseSuggestion!: (value: unknown) => void
    let releaseRun!: (value: unknown) => void
    const suggestionPending = new Promise<unknown>(resolve => { releaseSuggestion = resolve })
    const runPending = new Promise<unknown>(resolve => { releaseRun = resolve })
    vi.mocked(api).mockImplementation((path: string) => {
      if (path === '/ai/patch-workflow') return suggestionPending
      if (path === '/dlq/validate-fix') return Promise.resolve({ runId: 'val-focus' })
      if (path.startsWith('/run?')) return runPending
      return Promise.resolve({ ok: true })
    })

    render(<RecoveryDialog dlq={dlq} onClose={vi.fn()} />)
    const dialog = screen.getByRole('dialog')
    const generate = screen.getByRole('button', { name: /Generate suggestion/i })
    await waitFor(() => expect(generate).toHaveFocus())

    fireEvent.click(generate)
    await waitFor(() => expect(dialog).toHaveFocus())
    // While all footer/header controls are disabled, Tab must not escape.
    expect(fireEvent.keyDown(dialog, { key: 'Tab' })).toBe(false)
    expect(dialog).toHaveFocus()
    releaseSuggestion(suggestion)
    const validate = await screen.findByRole('button', { name: /Validate in sandbox/i })
    expect(dialog).toHaveFocus()
    // Keyboard navigation must remain trapped even when the dialog root
    // temporarily owns focus after an asynchronous action is replaced.
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(validate).toHaveFocus()

    fireEvent.click(validate)
    await waitFor(() => expect(dialog).toHaveFocus())
    releaseRun({
      run: { id: 'val-focus', status: 'succeeded' }, nodes: [], events: [],
      eventsCursor: null, eventsHasMore: false,
    })
    const apply = await screen.findByRole('button', { name: /Apply validated fix/i })
    expect(dialog).toHaveFocus()
    expect(apply).not.toHaveFocus()
  })

  it('starts only one sandbox when Validate is activated twice before the request returns', async () => {
    let releaseValidation!: (value: unknown) => void
    const validationPending = new Promise<unknown>(resolve => { releaseValidation = resolve })
    vi.mocked(api).mockImplementation((path: string) => {
      if (path === '/ai/patch-workflow') return Promise.resolve(suggestion)
      if (path === '/dlq/validate-fix') return validationPending
      if (path.startsWith('/run?')) return new Promise(() => {})
      return Promise.resolve({ ok: true })
    })

    const onClose = vi.fn()
    render(<RecoveryDialog dlq={dlq} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: /Generate suggestion/i }))
    const validate = await screen.findByRole('button', { name: /Validate in sandbox/i })
    fireEvent.click(validate)
    fireEvent.click(validate)
    expect(vi.mocked(api).mock.calls.filter(([path]) => path === '/dlq/validate-fix')).toHaveLength(1)
    const dialog = screen.getByRole('dialog')
    await waitFor(() => expect(dialog).toHaveFocus())
    expect(screen.getByRole('button', { name: /Close recovery dialog/i })).toBeDisabled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    releaseValidation({ runId: 'val-once' })
  })

  it('permits a fresh validation after a failed request is retried', async () => {
    let validationRequests = 0
    vi.mocked(api).mockImplementation((path: string) => {
      if (path === '/ai/patch-workflow') return Promise.resolve(suggestion)
      if (path === '/dlq/validate-fix') {
        validationRequests += 1
        return validationRequests === 1
          ? Promise.reject(new Error('validation transport failed'))
          : Promise.resolve({ runId: 'val-retry' })
      }
      if (path.startsWith('/run?')) return new Promise(() => {})
      return Promise.resolve({ ok: true })
    })

    render(<RecoveryDialog dlq={dlq} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Generate suggestion/i }))
    fireEvent.click(await screen.findByRole('button', { name: /Validate in sandbox/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('validation transport failed')
    fireEvent.click(screen.getByRole('button', { name: /Review patch/i }))
    expect(vi.mocked(api).mock.calls.filter(([path]) => path === '/ai/patch-workflow')).toHaveLength(1)
    fireEvent.click(await screen.findByRole('button', { name: /Validate in sandbox/i }))
    expect(validationRequests).toBe(2)
  })

  it('recovers from a validation response without a run id', async () => {
    vi.mocked(api).mockImplementation((path: string) => {
      if (path === '/ai/patch-workflow') return Promise.resolve(suggestion)
      if (path === '/dlq/validate-fix') return Promise.resolve({})
      return Promise.resolve({ ok: true })
    })

    render(<RecoveryDialog dlq={dlq} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Generate suggestion/i }))
    fireEvent.click(await screen.findByRole('button', { name: /Validate in sandbox/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/unreadable response/i)
    expect(screen.getByRole('button', { name: /Close recovery dialog/i })).toBeEnabled()
  })

  it('recovers when the validation start request never answers', async () => {
    const deadline = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    try {
      vi.mocked(api).mockImplementation((path: string, options?: RequestInit) => {
        if (path === '/ai/patch-workflow') return Promise.resolve(suggestion)
        if (path === '/dlq/validate-fix') return new Promise((_, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new DOMException('Request cancelled', 'AbortError')), { once: true })
        })
        return Promise.resolve({ ok: true })
      })

      render(<RecoveryDialog dlq={dlq} onClose={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: /Generate suggestion/i }))
      fireEvent.click(await screen.findByRole('button', { name: /Validate in sandbox/i }))
      expect(screen.getByRole('button', { name: /Close recovery dialog/i })).toBeDisabled()
      deadline.abort(new DOMException('Validation start timed out', 'TimeoutError'))
      expect(await screen.findByRole('alert')).toHaveTextContent(/check Runs.*before retrying/i)
      expect(screen.getByRole('button', { name: /Close recovery dialog/i })).toBeEnabled()
      expect(timeout).toHaveBeenCalledWith(60_000)
      fireEvent.click(screen.getByRole('button', { name: /Review patch/i }))
      expect(await screen.findByRole('button', { name: /Validate in sandbox/i })).toBeEnabled()
      expect(vi.mocked(api).mock.calls.filter(([path]) => path === '/ai/patch-workflow')).toHaveLength(1)
      expect(vi.mocked(api).mock.calls.filter(([path]) => path === '/dlq/validate-fix')).toHaveLength(1)
    } finally {
      timeout.mockRestore()
    }
  })
})

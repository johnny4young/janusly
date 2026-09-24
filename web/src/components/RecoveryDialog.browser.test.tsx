import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { useWorkflowStore } from '../store'
import { RecoveryDialog } from './RecoveryDialog'
import type { DeadLetter } from './DeadLettersPanel'

vi.mock('../api', () => {
  const module = { api: vi.fn() }
  return {
    ...module,
    contractApi: (_operation: string, path: string, _request: unknown, options?: RequestInit) =>
      options === undefined ? module.api(path) : module.api(path, options),
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
})

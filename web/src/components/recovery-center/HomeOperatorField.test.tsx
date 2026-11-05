import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../../api'
import { useWorkflowStore } from '../../store'
import { HomeOperatorField } from './HomeOperatorField'

vi.mock('../../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api')>()),
  api: vi.fn(),
}))

const failedRun = { id: 'dlq-1', runId: 'run-12345678-failed' }
const report = {
  summary: { runId: failedRun.runId, status: 'failed' },
  rootCause: { signature: 'DNS lookup failed' },
  failedNode: { nodeId: 'fetch', errorSummary: 'no such host' },
  nextAction: 'Review the failing node.',
}
const draft = [{ id: 'n1', type: 'http', position: { x: 0, y: 0 }, data: { type: 'http', label: 'n1', config: {} } }]

type FieldProps = Parameters<typeof HomeOperatorField>[0]

function setup(props: Partial<FieldProps> = {}) {
  const handlers = { onOpenTab: vi.fn(), onOpenRun: vi.fn(), onOpenRecoveryQueue: vi.fn() }
  const element = (next: Partial<FieldProps> = {}) => (
    <HomeOperatorField openFailures={[failedRun]} {...handlers} {...props} {...next} />
  )
  const { rerender } = render(element())
  return { ...handlers, update: (next: Partial<FieldProps>) => rerender(element(next)) }
}

function ask(question: string) {
  fireEvent.change(screen.getByTestId('home-operator-input'), { target: { value: question } })
  fireEvent.click(screen.getByTestId('home-operator-ask'))
}

function lastBody() {
  const [path, options] = vi.mocked(api).mock.calls.at(-1)!
  return { path, body: JSON.parse(String(options?.body)) as Record<string, unknown> }
}

describe('<HomeOperatorField />', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    useWorkflowStore.setState({ nodes: [], edges: [], currentWorkflowName: 'Orders', currentWorkflowId: 'wf-1' })
  })

  it('shows only the field until the operator asks', async () => {
    setup()
    expect(screen.getByTestId('home-operator-field')).toBeInTheDocument()
    expect(screen.getByTestId('home-operator-ask')).toBeDisabled()
    expect(screen.queryByTestId('home-operator-panel')).toBeNull()
    expect(api).not.toHaveBeenCalled()
  })

  it('answers about the failed run without AI, says so, and cites the returned run', async () => {
    vi.mocked(api).mockResolvedValue({ mode: 'fallback', explanation: '# Run Explain Report', report })
    const { onOpenRun, onOpenRecoveryQueue } = setup()

    ask('What broke?')

    expect(await screen.findByTestId('home-operator-panel')).toBeInTheDocument()
    expect(await screen.findByTestId('home-operator-answer')).toBeInTheDocument()
    expect(lastBody()).toEqual({
      path: '/ai/explain-run',
      body: { runId: failedRun.runId, question: 'What broke?' },
    })
    expect(screen.getByTestId('home-operator-mode')).toHaveTextContent('No AI provider is configured')
    expect(screen.queryByText(/About the current draft/)).toBeNull()
    expect(screen.getByText('DNS lookup failed')).toBeInTheDocument()
    expect(screen.getByText('no such host')).toBeInTheDocument()
    expect(screen.getByText('Review the failing node.')).toBeInTheDocument()
    expect(screen.getByTestId('home-operator-full-report')).toHaveTextContent('# Run Explain Report')

    const citation = screen.getByTestId('home-operator-citation')
    expect(citation).toHaveTextContent('run-1234')
    fireEvent.click(citation)
    expect(onOpenRun).toHaveBeenCalledWith(failedRun.runId)

    fireEvent.click(screen.getByTestId('home-operator-action'))
    expect(onOpenRecoveryQueue).toHaveBeenCalledWith('dlq-1')
  })

  it('reports a provider failure with its detail and keeps the deterministic answer', async () => {
    vi.mocked(api).mockResolvedValue({ mode: 'fallback', aiError: 'rate limit', explanation: 'report', report })
    setup()
    ask('What broke?')
    const mode = await screen.findByTestId('home-operator-mode')
    expect(mode).toHaveTextContent('The AI provider could not answer')
    expect(mode).toHaveTextContent('rate limit')
  })

  it('treats the missing-key message as no provider, without echoing it', async () => {
    useWorkflowStore.setState({ nodes: draft as never })
    vi.mocked(api).mockResolvedValue({ mode: 'fallback', aiError: 'AI provider not configured', explanation: 'Static answer' })
    setup()
    ask('Review this')
    const mode = await screen.findByTestId('home-operator-mode')
    expect(mode).toHaveTextContent('No AI provider is configured')
    expect(mode).not.toHaveTextContent('AI provider not configured')
  })

  it('shows AI prose as the answer with no fallback note', async () => {
    vi.mocked(api).mockResolvedValue({ mode: 'ai', explanation: 'The lookup failed.', report })
    setup()
    ask('What broke?')
    expect(await screen.findByText('The lookup failed.')).toBeInTheDocument()
    expect(screen.getByTestId('home-operator-mode')).toHaveTextContent('AI')
    expect(screen.getByTestId('home-operator-mode')).not.toHaveTextContent('deterministic')
    expect(screen.queryByTestId('home-operator-full-report')).toBeNull()
    expect(screen.getByTestId('home-operator-citation')).toBeInTheDocument()
  })

  it('cites nothing and offers no recovery when the API returned no run', async () => {
    useWorkflowStore.setState({ nodes: draft as never })
    vi.mocked(api).mockResolvedValue({ mode: 'ai', explanation: 'It fetches orders.' })
    const { onOpenTab } = setup()

    ask('What does this do?')

    expect(await screen.findByText('It fetches orders.')).toBeInTheDocument()
    expect(lastBody().path).toBe('/ai/explain-workflow')
    expect(lastBody().body.prompt).toBe('What does this do?')
    expect((lastBody().body.workflow as { name: string }).name).toBe('Orders')
    expect(screen.getByText('About the current draft: Orders')).toBeInTheDocument()
    expect(screen.queryByTestId('home-operator-citation')).toBeNull()
    expect(screen.queryByTestId('home-operator-action')).toBeNull()
    fireEvent.click(screen.getByTestId('home-operator-open-studio'))
    expect(onOpenTab).toHaveBeenCalledWith('ai-studio')
  })

  it('offers no recovery for a cited run the failed-run row does not match', async () => {
    vi.mocked(api).mockResolvedValue({
      mode: 'fallback',
      explanation: 'x',
      report: { ...report, summary: { runId: 'other-run', status: 'done' } },
    })
    setup()
    ask('What broke?')
    expect(await screen.findByTestId('home-operator-citation')).toBeInTheDocument()
    expect(screen.queryByTestId('home-operator-action')).toBeNull()
  })

  it('keeps the action when a newer failure arrives and drops it once the case closes', async () => {
    vi.mocked(api).mockResolvedValue({ mode: 'fallback', explanation: 'x', report })
    const { update, onOpenRecoveryQueue } = setup()
    ask('What broke?')
    await screen.findByTestId('home-operator-action')

    update({ openFailures: [{ id: 'dlq-2', runId: 'run-newer' }, failedRun] })
    fireEvent.click(screen.getByTestId('home-operator-action'))
    expect(onOpenRecoveryQueue).toHaveBeenCalledWith('dlq-1')

    update({ openFailures: [{ id: 'dlq-2', runId: 'run-newer' }] })
    expect(screen.queryByTestId('home-operator-action')).toBeNull()
    expect(api).toHaveBeenCalledTimes(1)
  })

  it('asks for a draft instead of calling the API when there is nothing to explain', async () => {
    setup({ openFailures: [] })
    ask('Anything?')
    expect(await screen.findByTestId('home-operator-needs-draft')).toBeInTheDocument()
    expect(api).not.toHaveBeenCalled()
    expect(screen.getByTestId('home-operator-open-studio')).toBeInTheDocument()
    expect(screen.queryByTestId('home-operator-busy')).toBeNull()
  })

  it('shows a request failure inside the panel', async () => {
    vi.mocked(api).mockRejectedValue(new Error('budget exhausted'))
    setup()
    ask('What broke?')
    expect(await screen.findByTestId('home-operator-error')).toHaveTextContent('budget exhausted')
  })

  it('keeps all five suggestions and their routes when nothing is loaded', async () => {
    const { onOpenTab } = setup({ openFailures: [] })
    fireEvent.click(screen.getByTestId('home-operator-suggestions'))
    await screen.findByTestId('home-operator-panel')

    for (const [id, tab] of [
      ['suggestFix', 'operations'],
      ['whyFail', 'runs'],
      ['whatChanged', 'inspector'],
      ['summarize', 'operations'],
      ['spend', 'operations'],
    ] as const) {
      onOpenTab.mockClear()
      fireEvent.click(screen.getByTestId(`home-operator-suggestion-${id}`))
      expect(onOpenTab).toHaveBeenCalledWith(tab)
    }
    expect(api).not.toHaveBeenCalled()
  })

  it('asks the suggestion intents against the right surface', async () => {
    useWorkflowStore.setState({ nodes: draft as never })
    vi.mocked(api).mockResolvedValue({ mode: 'fallback', explanation: 'ok' })
    setup()
    fireEvent.click(screen.getByTestId('home-operator-suggestions'))
    fireEvent.click(await screen.findByTestId('home-operator-suggestion-spend'))
    await screen.findByTestId('home-operator-answer')
    expect(lastBody().path).toBe('/ai/explain-workflow')
    expect(String(lastBody().body.prompt)).toContain('per-run cost')

    fireEvent.click(screen.getByTestId('home-operator-suggestion-whyFail'))
    await waitFor(() => expect(lastBody().path).toBe('/ai/explain-run'))
    expect(lastBody().body.runId).toBe(failedRun.runId)
  })

  it('lets the newest question win over one still in flight', async () => {
    let resolveFirst: (value: unknown) => void = () => {}
    vi.mocked(api).mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
    vi.mocked(api).mockResolvedValueOnce({ mode: 'ai', explanation: 'Second answer' })
    setup()

    ask('First?')
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1))
    const firstSignal = vi.mocked(api).mock.calls[0]?.[1]?.signal
    expect(await screen.findByTestId('home-operator-busy')).toBeInTheDocument()
    ask('Second?')

    expect(await screen.findByText('Second answer')).toBeInTheDocument()
    expect(firstSignal?.aborted).toBe(true)
    await act(async () => { resolveFirst({ mode: 'ai', explanation: 'First answer' }) })
    expect(screen.queryByText('First answer')).toBeNull()
    expect(screen.getByText('Second answer')).toBeInTheDocument()
  })

  it('moves focus into the panel and back to the field on Escape and close', async () => {
    setup()
    fireEvent.click(screen.getByTestId('home-operator-suggestions'))
    const panel = await screen.findByTestId('home-operator-panel')
    expect(panel).toHaveFocus()
    expect(screen.getByRole('dialog', { name: 'Operator' })).toBe(panel)
    expect(screen.getByTestId('home-operator-suggestions')).toHaveAttribute('aria-expanded', 'true')

    fireEvent.keyDown(panel, { key: 'Escape' })
    expect(screen.queryByTestId('home-operator-panel')).toBeNull()
    expect(screen.getByTestId('home-operator-input')).toHaveFocus()

    fireEvent.click(screen.getByTestId('home-operator-suggestions'))
    fireEvent.click(await screen.findByTestId('home-operator-close'))
    expect(screen.queryByTestId('home-operator-panel')).toBeNull()
    expect(screen.getByTestId('home-operator-input')).toHaveFocus()

    fireEvent.click(screen.getByTestId('home-operator-suggestions'))
    await screen.findByTestId('home-operator-panel')
    fireEvent.keyDown(screen.getByTestId('home-operator-input'), { key: 'Escape' })
    expect(screen.queryByTestId('home-operator-panel')).toBeNull()
  })
})

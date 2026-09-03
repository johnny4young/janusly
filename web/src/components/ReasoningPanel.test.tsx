import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { RunEvent } from '../types'
import { ReasoningPanel } from './ReasoningPanel'

describe('<ReasoningPanel />', () => {
  const runUsage = {
    loadedRows: 6,
    truncated: true,
    rowCap: 10_000,
    llm: {
      calls: 3,
      inputTokens: 12_000,
      outputTokens: 2_500,
      totalTokens: 14_500,
      cachedInputTokens: 8_000,
      cacheCreationInputTokens: 1_000,
      knownCostUsd: 0.0425,
      unknownCostCalls: 1,
    },
    memory: {
      recalls: 2,
      commits: 1,
      failures: 1,
      kinds: [{ kind: 'agent_episode', recalls: 2, commits: 1, failures: 1 }],
    },
  }

  it('renders payload fields as labelled rows with a raw-JSON toggle, not a raw dump', () => {
    const events: RunEvent[] = [
      {
        id: 'e1',
        type: 'node.completed',
        nodeId: 'http_call',
        payload: { decision: 'accept', attempts: 2, plan: { tool: 'http.request' } },
      },
    ]
    render(<ReasoningPanel events={events} />)

    // Primitive fields show as key → value rows.
    expect(screen.getByText('decision')).toBeInTheDocument()
    expect(screen.getByText('accept')).toBeInTheDocument()
    expect(screen.getByText('attempts')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    // Nested objects collapse to compact inline JSON (the raw toggle has the full shape).
    expect(screen.getByText('plan')).toBeInTheDocument()
    expect(screen.getByText('{"tool":"http.request"}')).toBeInTheDocument()
    // The raw JSON is behind a toggle, not the primary view.
    expect(screen.getByText('Show raw event')).toBeInTheDocument()
    // The node id is still shown.
    expect(screen.getByText('http_call')).toBeInTheDocument()
  })

  it('omits the field list and raw toggle for an empty payload', () => {
    const events: RunEvent[] = [{ id: 'e2', type: 'run.started', payload: {} }]
    render(<ReasoningPanel events={events} />)
    expect(screen.queryByText('Show raw event')).not.toBeInTheDocument()
  })

  it('renders only the closed scrubbed projection for the stable agent reasoning event', () => {
    const secret = `sk-proj-${'a'.repeat(24)}`
    render(<ReasoningPanel events={[
      {
        id: 'reason-legacy',
        type: 'agent.step.planned',
        nodeId: 'triage',
        createdAt: '2026-07-15T10:00:00.000Z',
        payload: { agent: 'invoice-agent', iteration: 0, plan: { tool: 'db.query.read' } },
      },
      {
        id: 'reason-1',
        type: 'agent.reasoning',
        nodeId: 'triage',
        createdAt: '2026-07-15T10:00:00.001Z',
        payload: {
          agent: 'invoice-agent',
          iteration: 0,
          planner: 'ai',
          mode: 'ai',
          scope: 'agent',
          replacesEventId: 'reason-legacy',
          decision: 'use_tool',
          tool: 'db.query.read',
          reason: `Inspect\nBearer ${'a'.repeat(24)} and ${secret} before choosing a recovery path.`,
          untrustedExtra: secret,
        },
      },
    ]} />)

    const summary = screen.getByTestId('agent-reasoning-summary')
    expect(summary).toHaveAccessibleName('Agent operational rationale')
    expect(summary).toHaveTextContent('Why this step?')
    expect(summary).toHaveTextContent('Inspect [redacted] and [redacted] before choosing a recovery path.')
    expect(summary).toHaveTextContent('Agent invoice-agent')
    expect(summary).toHaveTextContent('Tool db.query.read')
    expect(summary).toHaveTextContent('Step 1')
    expect(screen.getByTestId('run-event-reason-1')).toHaveAttribute('data-tone', 'info')
    expect(screen.queryByTestId('run-event-reason-legacy')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Show raw event'))
    const eventCard = screen.getByTestId('run-event-reason-1')
    expect(eventCard).not.toHaveTextContent(secret)
    expect(eventCard).not.toHaveTextContent('untrustedExtra')
    expect(eventCard).toHaveTextContent('[redacted]')
  })

  it('fails closed without raw fields when an agent reasoning payload is malformed', () => {
    const secret = `sk-proj-${'b'.repeat(24)}`
    render(<ReasoningPanel events={[{
      id: 'reason-bad',
      type: 'agent.reasoning',
      nodeId: 'triage',
      payload: { decision: 'use_tool', reason: secret },
    }]} />)

    expect(screen.queryByTestId('agent-reasoning-summary')).not.toBeInTheDocument()
    expect(screen.getByTestId('agent-reasoning-invalid')).toHaveTextContent('This reasoning event could not be displayed safely.')
    expect(screen.getByTestId('run-event-reason-bad')).not.toHaveTextContent(secret)
    expect(screen.queryByText('decision')).not.toBeInTheDocument()
    expect(screen.queryByText('Show raw event')).not.toBeInTheDocument()
  })

  it('shows exact timestamps and inter-event deltas while de-emphasizing noise', () => {
    const events: RunEvent[] = [
      { id: 'e3', type: 'node.failed', nodeId: 'fetch', createdAt: '2026-07-12T10:00:03.500Z' },
      { id: 'e1', type: 'run.started', createdAt: '2026-07-12T10:00:00.000Z' },
      { id: 'e2', type: 'node.queued', nodeId: 'fetch', createdAt: '2026-07-12T10:00:01.250Z' },
    ]
    render(<ReasoningPanel events={events} />)

    expect(screen.getByTestId('run-event-e2')).toHaveAttribute('data-noise', 'true')
    expect(screen.getByTestId('run-event-e2')).toHaveAttribute('data-tone', 'neutral')
    expect(screen.getByTestId('run-event-e3')).toHaveAttribute('data-tone', 'error')
    expect(screen.getByLabelText('1s since the previous event')).toBeInTheDocument()
    expect(screen.getByLabelText('2s since the previous event')).toBeInTheDocument()
    expect(screen.getAllByRole('time')).toHaveLength(3)
    expect(screen.getAllByRole('time')[0]).toHaveAttribute('datetime', '2026-07-12T10:00:03.500Z')
  })

  it('filters by node or payload and distinguishes no matches from no events', () => {
    render(<ReasoningPanel events={[
      { id: 'e1', type: 'node.running', nodeId: 'fetch_invoice', payload: { invoice: 'inv-42' } },
      { id: 'e2', type: 'node.succeeded', nodeId: 'notify_customer', payload: { channel: 'email' } },
    ]} />)

    const filter = screen.getByTestId('run-event-filter')
    fireEvent.change(filter, { target: { value: 'inv-42' } })
    expect(screen.getByText('1 of 2 events')).toBeInTheDocument()
    expect(screen.getByTestId('run-event-e1')).toBeInTheDocument()
    expect(screen.queryByTestId('run-event-e2')).not.toBeInTheDocument()

    fireEvent.change(filter, { target: { value: 'missing-node' } })
    expect(screen.getByText('No matching events')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }))
    expect(screen.getByText('2 of 2 events')).toBeInTheDocument()
  })

  it('clears an active filter and focuses the earliest failure', async () => {
    render(<ReasoningPanel events={[
      { id: 'e1', type: 'run.started', createdAt: '2026-07-12T10:00:00.000Z' },
      { id: 'e2', type: 'node.failed', nodeId: 'first_failure', createdAt: '2026-07-12T10:00:01.000Z' },
      { id: 'e3', type: 'node.failed', nodeId: 'later_failure', createdAt: '2026-07-12T10:00:02.000Z' },
    ]} />)

    fireEvent.change(screen.getByTestId('run-event-filter'), { target: { value: 'later_failure' } })
    expect(screen.queryByTestId('run-event-e2')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Jump to first failure' }))

    await waitFor(() => expect(screen.getByTestId('run-event-filter')).toHaveValue(''))
    await waitFor(() => expect(screen.getByTestId('run-event-e2')).toHaveFocus())
  })

  it('scopes filtering and failure navigation to loaded events when older pages remain', () => {
    render(<ReasoningPanel
      events={[{ id: 'e1', type: 'node.running', nodeId: 'current_page' }]}
      eventsHasMore
      onLoadOlderEvents={() => {}}
    />)

    expect(screen.getByText('1 of 1 loaded event')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Jump to first loaded failure' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Jump to first loaded failure' }))
      .toHaveAttribute('title', 'A failure may be in older events. Load more history first.')

    fireEvent.change(screen.getByTestId('run-event-filter'), { target: { value: 'missing' } })
    expect(screen.getByText('No loaded events match. Load older events to search more history.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Load older events' })).toBeInTheDocument()
  })

  it('windows a thousand-event timeline once the scroll owner is measured', async () => {
    const events = Array.from({ length: 1_000 }, (_, index): RunEvent => ({
      id: `event-${index}`,
      type: 'node.running',
      nodeId: `node-${index}`,
      createdAt: new Date(Date.UTC(2026, 6, 12, 10, 0, index)).toISOString(),
    }))
    render(<ReasoningPanel events={events} />)
    const container = screen.getByTestId('run-event-virtual-list')
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 344 })
    fireEvent.scroll(container)

    await waitFor(() => expect(screen.getAllByRole('listitem').length).toBeLessThan(20))
    expect(screen.getByRole('list', { name: 'Run event timeline' })).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')[0]).toHaveAttribute('aria-posinset', '1')
    expect(screen.getAllByRole('listitem')[0]).toHaveAttribute('aria-setsize', '1000')
    expect(screen.getAllByRole('listitem')[0]).toHaveAccessibleName(/node-999/i)
    expect(screen.getByText('1000 of 1000 events')).toBeInTheDocument()
  }, 15_000)

  it('summarizes the loaded history without claiming partial pages are complete', () => {
    render(<ReasoningPanel
      events={[
        { id: 'e1', type: 'run.started', createdAt: '2026-07-12T10:00:00.000Z' },
        { id: 'e2', type: 'node.retry', nodeId: 'fetch', createdAt: '2026-07-12T10:00:01.000Z' },
        { id: 'e3', type: 'node.failed', nodeId: 'fetch', createdAt: '2026-07-12T10:00:02.000Z' },
        { id: 'e4', type: 'decision.made', nodeId: 'route', createdAt: '2026-07-12T10:00:03.000Z' },
        { id: 'e5', type: 'agent.memory.recalled', nodeId: 'agent', payload: { count: 2 }, createdAt: '2026-07-12T10:00:04.000Z' },
      ]}
      eventsHasMore
    />)

    const diagnostics = screen.getByTestId('run-diagnostics')
    expect(diagnostics).toHaveAccessibleName('Loaded run diagnostics')
    expect(diagnostics).toHaveTextContent('Loaded-history diagnostics')
    expect(diagnostics).toHaveTextContent('Partial history')
    expect(diagnostics).toHaveTextContent('Episodes recalled2')
    expect(diagnostics).toHaveTextContent('Observed span4s')
  })

  it('loads persisted whole-run usage and refreshes only at terminal checkpoints', async () => {
    const loadRunUsage = vi.fn().mockResolvedValue(runUsage)
    const { rerender } = render(<ReasoningPanel
      activeRunId="run-usage"
      onLoadRunUsage={loadRunUsage}
      events={[{ id: 'e1', type: 'node.running', nodeId: 'agent' }]}
    />)

    expect(screen.getByRole('status')).toHaveTextContent('Loading persisted usage')
    const usage = await screen.findByTestId('run-resource-usage')
    await waitFor(() => expect(usage).toHaveAttribute('data-state', 'ready'))
    expect(usage).toHaveAttribute('role', 'status')
    expect(usage).toHaveAttribute('aria-live', 'polite')
    expect(usage).toHaveAccessibleName('Run resource usage')
    expect(usage).toHaveTextContent('LLM calls3')
    expect(usage).toHaveTextContent('Cache read8,000')
    expect(usage).toHaveTextContent('Known cost$0.0425')
    expect(usage).toHaveTextContent('Newest 10,000 records')
    expect(usage).toHaveTextContent('1 LLM call has no known price')
    expect(screen.getByRole('list', { name: 'Memory usage by kind' })).toHaveTextContent('agent_episode')
    expect(loadRunUsage).toHaveBeenCalledTimes(1)

    rerender(<ReasoningPanel
      activeRunId="run-usage"
      onLoadRunUsage={loadRunUsage}
      events={[
        { id: 'e1', type: 'node.running', nodeId: 'agent' },
        { id: 'e2', type: 'node.started', nodeId: 'notify' },
      ]}
    />)
    expect(loadRunUsage).toHaveBeenCalledTimes(1)

    rerender(<ReasoningPanel
      activeRunId="run-usage"
      onLoadRunUsage={loadRunUsage}
      events={[
        { id: 'e1', type: 'node.running', nodeId: 'agent' },
        { id: 'e2', type: 'node.started', nodeId: 'notify' },
        { id: 'e3', type: 'node.succeeded', nodeId: 'notify' },
      ]}
    />)
    await waitFor(() => expect(loadRunUsage).toHaveBeenCalledTimes(2))
  })

  it('renders explicit empty and error states for persisted run usage', async () => {
    const emptyUsage = {
      ...runUsage,
      loadedRows: 0,
      truncated: false,
      llm: { ...runUsage.llm, calls: 0 },
      memory: { recalls: 0, commits: 0, failures: 0, kinds: [] },
    }
    const loadRunUsage = vi.fn().mockResolvedValueOnce(emptyUsage)
    const { rerender } = render(<ReasoningPanel
      activeRunId="run-empty"
      onLoadRunUsage={loadRunUsage}
      events={[]}
    />)

    await waitFor(() => expect(screen.getByTestId('run-resource-usage')).toHaveAttribute('data-state', 'empty'))
    expect(screen.getByTestId('run-resource-usage')).toHaveTextContent('No AI or memory usage has been recorded')

    loadRunUsage.mockRejectedValueOnce(new Error('usage offline'))
    rerender(<ReasoningPanel
      activeRunId="run-error"
      onLoadRunUsage={loadRunUsage}
      events={[]}
    />)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('usage offline'))
  })

  it('fails closed with a localized error when the run-usage response is malformed', async () => {
    const loadRunUsage = vi.fn().mockResolvedValue({ loadedRows: 1, llm: {}, memory: {} })
    render(<ReasoningPanel
      activeRunId="run-malformed"
      onLoadRunUsage={loadRunUsage}
      events={[]}
    />)

    const error = await screen.findByRole('alert')
    expect(error).toHaveAttribute('data-state', 'error')
    expect(error).toHaveTextContent("The server returned usage data Janusly couldn't validate.")
  })

  it('offers deterministic What-if replay only for recorded decisions and renders the ranking', async () => {
    let release!: (value: unknown) => void
    const replayDecision = vi.fn(() => new Promise(resolve => { release = resolve }))
    render(<ReasoningPanel
      activeRunId="run/with spaces"
      onReplayDecision={replayDecision}
      events={[
        { id: 'e1', type: 'node.skipped', nodeId: 'losing_path' },
        { id: 'e2', type: 'decision.made', nodeId: 'route-a' },
      ]}
    />)

    expect(screen.getAllByRole('button', { name: 'What if?' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'What if?' }))
    expect(screen.getByTestId('causal-analysis')).toHaveAttribute('data-state', 'loading')
    expect(replayDecision).toHaveBeenCalledWith('e2', 'route-a', expect.any(AbortSignal))

    const fast = { nodeId: 'fast_path', score: 1, breakdown: { cost: 0.01, latency: 25, quality: 0.98, penalty: 0.02 } }
    const safe = { nodeId: 'safe_path', score: 2, breakdown: { cost: 0.02, latency: 80, quality: 0.99, penalty: 0.01 } }
    release({ chosen: safe, best: fast, ranking: [fast, safe] })

    await waitFor(() => expect(screen.getByTestId('causal-analysis')).toHaveAttribute('data-state', 'ready'))
    expect(screen.getByTestId('causal-analysis')).toHaveTextContent('The run chose safe_path; current scoring now ranks fast_path first.')
    expect(screen.getByRole('list', { name: 'Replayed candidate ranking' })).toHaveTextContent('1. fast_path')
  })

  it('fails closed on a malformed causal response and allows the operator to dismiss it', async () => {
    const replayDecision = vi.fn().mockResolvedValueOnce({ ranking: [] })
    render(<ReasoningPanel
      activeRunId="run-1"
      onReplayDecision={replayDecision}
      events={[{ id: 'e1', type: 'decision.made', nodeId: 'route-a' }]}
    />)

    const trigger = screen.getByRole('button', { name: 'What if?' })
    fireEvent.click(trigger)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('returned an incomplete result'))
    fireEvent.click(screen.getByRole('button', { name: 'Close What-if analysis' }))
    expect(screen.queryByTestId('causal-analysis')).not.toBeInTheDocument()
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('never renders a causal result under a different selected run', async () => {
    let release!: (value: unknown) => void
    const replayDecision = vi.fn(() => new Promise(resolve => { release = resolve }))
    const { rerender } = render(<ReasoningPanel
      activeRunId="run-1"
      onReplayDecision={replayDecision}
      events={[{ id: 'e1', type: 'decision.made', nodeId: 'route-a' }]}
    />)

    fireEvent.click(screen.getByRole('button', { name: 'What if?' }))
    expect(screen.getByTestId('causal-analysis')).toHaveAttribute('data-state', 'loading')

    rerender(<ReasoningPanel
      activeRunId="run-2"
      onReplayDecision={replayDecision}
      events={[{ id: 'e2', type: 'decision.made', nodeId: 'route-b' }]}
    />)
    expect(screen.queryByTestId('causal-analysis')).not.toBeInTheDocument()

    const candidate = { nodeId: 'old_path', score: 1, breakdown: { cost: 0.01, latency: 25, quality: 0.98, penalty: 0.02 } }
    release({ chosen: candidate, best: candidate, ranking: [candidate] })
    await waitFor(() => expect(screen.queryByTestId('causal-analysis')).not.toBeInTheDocument())
  })
})

import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { initI18n } from '../i18n'
import type { AgentSessionMap, AgentSessionSummary } from '../lib/agent-sessions'
import { AgentSessionsPanel } from './AgentSessionsPanel'

vi.mock('../api', async () => {
  const { contractApiOver } = await import('../test/contract-api-mock')
  const api = vi.fn()
  return { api, contractApi: contractApiOver(api) }
})

const summary: AgentSessionSummary = {
  id: 'sess-1', agentClientId: 'c1', agentClientName: 'Claude on laptop', runtime: 'claude-code',
  project: 'billing', model: 'opus', status: 'running', truncated: false, eventCount: 6,
  startedAt: '2026-11-12T10:00:00Z', lastEventAt: '2026-11-12T10:05:00Z', endedAt: null,
}

const detail: AgentSessionMap = {
  session: summary,
  lanes: [
    { nodeId: 'main', kind: 'external_agent', parentId: null, agentType: null, live: false, truncated: false,
      steps: [{ type: 'agent.session.started', at: '2026-11-12T10:00:00Z', index: 1 }] },
    { nodeId: 'sub-1', kind: 'external_subagent', parentId: 'main', agentType: 'Explore', live: true, truncated: false,
      steps: [{ type: 'agent.tool.completed', at: '2026-11-12T10:00:05Z', tool: 'mcp__notion__search', status: 'error', index: 2 }] },
  ],
  totals: { events: 6, toolCalls: 3, mcpCalls: 2, errors: 1 },
  liveSubagents: 1,
  refs: { workflowIds: [], draftIds: [], runIds: ['run_8c1'] },
  gates: [],
  conversion: { totalSteps: 3, convertibleSteps: 2, agents: 1, mcpServers: ['notion'], convertible: true },
  canConvert: true,
}

beforeEach(() => {
  initI18n('en')
  vi.mocked(api).mockReset()
  window.history.replaceState(null, '', '/#/multiAgent/sessions')
})
afterEach(() => vi.useRealTimers())

describe('<AgentSessionsPanel />', () => {
  it('lists sessions and opens one with its subagent nested under the main agent', async () => {
    vi.mocked(api).mockImplementation(async (path: string) =>
      path.includes('/map') ? detail : { sessions: [summary], nextCursor: null })
    const onOpenRun = vi.fn()
    render(<AgentSessionsPanel onOpenRun={onOpenRun} />)
    const list = await screen.findByTestId('agent-session-list')
    expect(within(list).getByText(/Claude on laptop · Claude Code · opus/)).toBeVisible()
    expect(within(list).getByTestId('agent-session-status')).toHaveTextContent('Running')
    fireEvent.click(within(list).getByRole('button', { name: 'billing' }))

    const lanes = await screen.findByTestId('agent-session-lanes')
    expect(window.location.hash).toBe('#/multiAgent/sessions/sess-1')
    const main = within(lanes).getByRole('region', { name: 'Main agent' })
    const sub = within(lanes).getByRole('region', { name: 'Explore' })
    expect(main.dataset.depth).toBe('0')
    expect(sub.dataset.depth).toBe('1')
    expect(within(sub).getByText('Live')).toBeVisible()
    expect(within(main).getByText('Session started')).toBeVisible()
    expect(within(sub).getByText('mcp__notion__search failed')).toBeVisible()
    expect(screen.getByTestId('agent-session-totals')).toHaveTextContent('Errors: 1')
    fireEvent.click(screen.getByRole('button', { name: 'Run run_8c1' }))
    expect(onOpenRun).toHaveBeenCalledWith('run_8c1')

    fireEvent.click(screen.getByRole('button', { name: 'All sessions' }))
    expect(await screen.findByTestId('agent-session-list')).toBeVisible()
    expect(window.location.hash).toBe('#/multiAgent/sessions')
  })

  it('opens the session named in the URL and polls while it runs', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    window.history.replaceState(null, '', '/#/multiAgent/sessions/sess-1')
    vi.mocked(api).mockResolvedValue(detail)
    render(<AgentSessionsPanel />)
    await screen.findByTestId('agent-session-detail')
    const calls = vi.mocked(api).mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(vi.mocked(api).mock.calls.length).toBeGreaterThan(calls)
    expect(vi.mocked(api).mock.calls[0]![0]).toBe('/v1/agent-sessions/sess-1/map')
  })

  it('stops polling an ended session and speaks Spanish', async () => {
    initI18n('es')
    vi.useFakeTimers({ shouldAdvanceTime: true })
    window.history.replaceState(null, '', '/#/multiAgent/sessions/sess-1')
    vi.mocked(api).mockResolvedValue({ ...detail, session: { ...summary, status: 'ended', endedAt: '2026-11-12T10:06:00Z' } })
    render(<AgentSessionsPanel />)
    expect(await screen.findByTestId('agent-session-status')).toHaveTextContent('Terminada')
    const calls = vi.mocked(api).mock.calls.length
    await vi.advanceTimersByTimeAsync(15000)
    expect(vi.mocked(api).mock.calls.length).toBe(calls)
  })

  it('shows the empty state and a retry on failure', async () => {
    vi.mocked(api).mockResolvedValueOnce({ sessions: [], nextCursor: null })
    const { unmount } = render(<AgentSessionsPanel />)
    expect(await screen.findByText('No agent sessions yet')).toBeVisible()
    unmount()
    vi.mocked(api).mockRejectedValueOnce(new Error('down'))
    render(<AgentSessionsPanel />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Agent sessions could not be loaded.')
  })

  it('shows a held tool call with its captured input and sends the decision', async () => {
    window.history.replaceState(null, '', '/#/multiAgent/sessions/sess-1')
    const gates = [
      { id: 'gate-1', tool: 'mcp__stripe__create_refund', mcpServer: 'stripe', agentId: null, contentCaptured: true,
        input: { charge: 'ch_1' }, expiresAt: '2026-11-12T10:15:00Z', needsYou: true },
      { id: 'gate-2', tool: 'Bash', mcpServer: null, agentId: null, contentCaptured: false,
        input: null, expiresAt: '2026-11-12T10:15:00Z', needsYou: false },
    ]
    vi.mocked(api).mockImplementation(async (path: string) =>
      path.includes('/decide') ? { gate: { id: 'gate-1', status: 'approved' } } : { ...detail, gates })
    render(<AgentSessionsPanel />)
    const cards = await screen.findAllByTestId('agent-session-gate')
    expect(within(cards[0]!).getByText(/"charge": "ch_1"/)).toBeVisible()
    expect(within(cards[1]!).getByText('Arguments were not captured for this call.')).toBeVisible()
    expect(within(cards[1]!).getByText('Someone else has to decide this call.')).toBeVisible()
    expect(within(cards[1]!).queryByRole('button')).toBeNull()
    fireEvent.click(within(cards[0]!).getByRole('button', { name: 'Approve' }))
    await vi.waitFor(() => expect(vi.mocked(api).mock.calls.some(([path, init]) =>
      path === '/v1/agent-sessions/gates/gate-1/decide' && String((init as RequestInit).body).includes('"approve"'))).toBe(true))
  })

  it('says what converts before saving, and saves a draft with its open placeholders', async () => {
    window.history.replaceState(null, '', '/#/multiAgent/sessions/sess-1')
    vi.mocked(api).mockImplementation(async (path: string) => path.endsWith('/draft')
      ? { draftId: 'draft_1', workflowId: 'wf_1', digest: 'd', conversion: detail.conversion, agents: [], mcpServers: ['notion'],
        placeholders: ['/nodes/agent_1/config/goal', '/outputs/result'], next: '' }
      : detail)
    render(<AgentSessionsPanel />)
    const card = await screen.findByTestId('agent-session-convert')
    expect(within(card).getByText(/2 of 3 tool calls can become workflow steps\. Only MCP tool calls convert/)).toBeVisible()
    fireEvent.click(within(card).getByRole('button', { name: 'Save as workflow draft' }))
    expect(await screen.findByTestId('agent-session-draft')).toHaveTextContent('Draft saved with 2 values to fill in before it can qualify. draft_1')
    expect(within(card).queryByRole('button')).toBeNull()
  })

  it('offers no conversion for a coding session or to someone who cannot write workflows', async () => {
    window.history.replaceState(null, '', '/#/multiAgent/sessions/sess-1')
    const none = { totalSteps: 4, convertibleSteps: 0, agents: 0, mcpServers: [], convertible: false }
    vi.mocked(api).mockResolvedValueOnce({ ...detail, conversion: none })
    const first = render(<AgentSessionsPanel />)
    const card = await screen.findByTestId('agent-session-convert')
    expect(within(card).getByText('Nothing here can become a workflow: the session used no MCP tools.')).toBeVisible()
    expect(within(card).queryByRole('button')).toBeNull()
    first.unmount()
    vi.mocked(api).mockResolvedValueOnce({ ...detail, session: { ...summary, status: 'ended' }, canConvert: false })
    render(<AgentSessionsPanel />)
    expect(within(await screen.findByTestId('agent-session-convert')).queryByRole('button')).toBeNull()
  })
})

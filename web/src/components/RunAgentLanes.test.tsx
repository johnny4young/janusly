import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { initI18n } from '../i18n'
import type { RunMap } from '../run-map'
import { RunAgentLanes } from './RunAgentLanes'

vi.mock('../api', async () => {
  const { contractApiOver } = await import('../test/contract-api-mock')
  const api = vi.fn()
  return { api, contractApi: contractApiOver(api) }
})

function map(lanes: RunMap['lanes']): RunMap {
  return {
    run: { id: 'run-lanes', status: 'succeeded', workflowVersionId: 'v', parentRunId: null },
    nodes: [], lanes, totals: { costUsd: 0, tokens: 0 },
  }
}

beforeEach(() => {
  vi.mocked(api).mockReset()
})

describe('<RunAgentLanes />', () => {
  it('draws agent and crew lanes from the run map', async () => {
    vi.mocked(api).mockResolvedValue(map([
      { nodeId: 'think', kind: 'agent', steps: [
        { type: 'agent.step.started', at: '2026-11-07T10:00:00Z', iteration: 0 },
        { type: 'agent.tool.started', at: '2026-11-07T10:00:12Z', tool: 'crm.lookup' },
      ], truncated: false },
      { nodeId: 'crew', kind: 'multi_agent', steps: [
        { type: 'multi_agent.started', at: null },
        { type: 'multi_agent.agent.0.tool.completed', at: null, agent: 'researcher', tool: 'search' },
      ], truncated: false },
    ]))
    render(<RunAgentLanes runId="run-lanes" />)
    const agent = await screen.findByRole('region', { name: 'think' })
    expect(within(agent).getByText('Agent')).toBeVisible()
    expect(within(agent).getByText('Step 1')).toBeVisible()
    expect(within(agent).getByText('Run crm.lookup')).toBeVisible()
    expect(within(agent).getByText('+12s')).toBeVisible()
    const crew = screen.getByRole('region', { name: 'crew' })
    expect(within(crew).getByRole('heading', { name: 'researcher' })).toBeVisible()
    expect(within(crew).getByRole('heading', { name: 'Team' })).toBeVisible()
    expect(within(crew).getByText('search returned')).toBeVisible()
    expect(vi.mocked(api).mock.calls[0]![0]).toBe('/v1/runs/run-lanes/map')
    expect(screen.queryByText('Only the latest events are shown.')).toBeNull()
  })

  it('says when a lane shows only its latest events, in Spanish too', async () => {
    initI18n('es')
    vi.mocked(api).mockResolvedValue(map([
      { nodeId: 'busy', kind: 'agent', steps: [{ type: 'agent.step.started', at: null, iteration: 4 }], truncated: true },
    ]))
    render(<RunAgentLanes runId="run-busy" />)
    const lane = await screen.findByRole('region', { name: 'busy' })
    expect(within(lane).getByText('Solo se muestran los eventos más recientes.')).toBeVisible()
  })

  it('says so when the run has no agent steps, in Spanish too', async () => {
    initI18n('es')
    vi.mocked(api).mockResolvedValue(map([]))
    render(<RunAgentLanes runId="run-empty" />)
    expect(await screen.findByTestId('run-agent-lanes-empty')).toHaveTextContent('Esta ejecución no tiene pasos de agentes.')
  })

  it('says the read failed instead of loading forever', async () => {
    vi.mocked(api).mockRejectedValue(new Error('forbidden'))
    render(<RunAgentLanes runId="run-denied" />)
    expect(await screen.findByTestId('run-agent-lanes-failed')).toBeVisible()
  })
})

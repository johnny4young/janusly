import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { RunEvent } from './types'
import { MultiAgentTimeline } from './MultiAgentTimeline'

const events: RunEvent[] = [
  { id: 'e1', type: 'multi_agent.started', payload: { count: 2 } },
  { id: 'e2', type: 'multi_agent.agent.0.tool.started', payload: { tool: 'http.request', name: 'researcher' } },
  {
    id: 'e3',
    type: 'agent.reasoning',
    payload: {
      agent: 'researcher', iteration: 0, planner: 'rules', mode: 'rules', scope: 'multi_agent.agent.0', replacesEventId: 'e-planned',
      decision: 'use_tool', tool: 'http.request', reason: 'Gather the source data first.',
    },
  },
]

describe('<MultiAgentTimeline />', () => {
  it('renders a tone legend above the lanes so the colour coding is discoverable', () => {
    render(<MultiAgentTimeline events={events} />)
    expect(screen.getByLabelText('What the colors mean')).toBeInTheDocument()
    expect(screen.getByText('Planning')).toBeInTheDocument()
    expect(screen.getByText('Tool call')).toBeInTheDocument()
    expect(screen.getByText('Failed · retry')).toBeInTheDocument()
    expect(screen.getByText('2 events')).toBeInTheDocument()
  })

  it('omits the legend when there is no team activity yet', () => {
    render(<MultiAgentTimeline events={[]} />)
    expect(screen.queryByLabelText('What the colors mean')).not.toBeInTheDocument()
    expect(screen.getByTestId('multi-agent-empty')).toBeInTheDocument()
  })
})

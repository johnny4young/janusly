import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { RunEvent } from './types'
import { MultiAgentTimeline } from './MultiAgentTimeline'

const events: RunEvent[] = [
  { id: 'e1', type: 'multi_agent.started', payload: { count: 2 } },
  { id: 'e2', type: 'multi_agent.agent.0.tool.started', payload: { tool: 'http.request', name: 'researcher' } },
]

describe('<MultiAgentTimeline />', () => {
  it('renders a tone legend above the lanes so the colour coding is discoverable', () => {
    render(<MultiAgentTimeline events={events} />)
    expect(screen.getByLabelText('What the colors mean')).toBeInTheDocument()
    expect(screen.getByText('Planning')).toBeInTheDocument()
    expect(screen.getByText('Tool call')).toBeInTheDocument()
    expect(screen.getByText('Failed · retry')).toBeInTheDocument()
  })

  it('omits the legend when there is no team activity yet', () => {
    render(<MultiAgentTimeline events={[]} />)
    expect(screen.queryByLabelText('What the colors mean')).not.toBeInTheDocument()
    expect(screen.getByTestId('multi-agent-empty')).toBeInTheDocument()
  })
})

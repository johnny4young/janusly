import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { RunEvent } from '../types'
import { ReasoningPanel } from './RightPanel'

describe('<ReasoningPanel />', () => {
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
})

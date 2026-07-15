import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { WorkflowGraphEdge, WorkflowGraphNode } from '../types'
import { ExpressionAssistant } from './ExpressionAssistant'

const nodes = [
  { id: 'fetch', position: { x: 0, y: 0 }, data: { label: '', type: 'http', config: {} } },
  { id: 'gate', position: { x: 100, y: 0 }, data: { label: '', type: 'condition', config: {} } },
] as WorkflowGraphNode[]
const edges = [{ id: 'fetch-gate', source: 'fetch', target: 'gate', data: {} }] as WorkflowGraphEdge[]

function renderAssistant(overrides: Partial<Parameters<typeof ExpressionAssistant>[0]> = {}) {
  const props: Parameters<typeof ExpressionAssistant>[0] = {
    id: 'gate-expression',
    label: 'Branch expression',
    value: 'context.input.amount > 0',
    onChange: vi.fn(),
    nodes,
    edges,
    targetNodeId: 'gate',
    mode: 'node',
    workflowInputs: { type: 'object', properties: { amount: { type: 'number' } } },
    ...overrides,
  }
  return { ...render(<ExpressionAssistant {...props} />), props }
}

describe('<ExpressionAssistant />', () => {
  it('validates with the runtime grammar and inserts a reachable path at the caret', () => {
    const { props } = renderAssistant()
    expect(screen.getByText('Expression matches the runtime grammar.')).toBeInTheDocument()
    const textarea = screen.getByLabelText('Branch expression') as HTMLTextAreaElement
    textarea.focus()
    textarea.setSelectionRange(0, 0)
    fireEvent.click(screen.getByRole('button', { name: /use context/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Insert context.fetch.output.statusCode at the cursor' }))
    expect(props.onChange).toHaveBeenCalledWith('context.fetch.output.statusCodecontext.input.amount > 0')
  })

  it('surfaces parser failures and the edge-only inputs scope trap', () => {
    const { rerender, props } = renderAssistant({ value: 'process.exit()' })
    expect(screen.getByRole('alert')).toHaveTextContent('Unsupported expression token')

    rerender(<ExpressionAssistant {...props} mode="edge" value="inputs.threshold > 0" />)
    expect(screen.getByRole('alert')).toHaveTextContent('Edge conditions cannot use inputs.*')

    rerender(<ExpressionAssistant {...props} mode="edge" value="inputs[0].threshold > 0" />)
    expect(screen.getByRole('alert')).toHaveTextContent('Edge conditions cannot use inputs.*')
  })

  it('does not render a removed or disconnected node as context', () => {
    const { rerender, props } = renderAssistant({ nodes: nodes.filter((node) => node.id !== 'fetch'), edges: [] })
    fireEvent.click(screen.getByRole('button', { name: /use context/i }))
    expect(screen.queryByText('context.fetch.output', { exact: true })).not.toBeInTheDocument()
    rerender(<ExpressionAssistant {...props} nodes={[]} edges={[]} value="context.fetch.output.ok === true" />)
    expect(screen.getByRole('alert')).toHaveTextContent('Not reachable here: context.fetch.output.ok')
  })

  it('reports canonical grammar errors before graph-reference guidance', () => {
    renderAssistant({ value: 'context.missing.output +' })
    expect(screen.getByRole('alert')).toHaveTextContent('Unsupported expression token')
    expect(screen.getByRole('alert')).not.toHaveTextContent('Not reachable here')
  })

  it('offers the richer runtime operators as editable expression templates', () => {
    const { props } = renderAssistant({ value: 'context.input.customerTier' })
    fireEvent.click(screen.getByRole('button', { name: /use context/i }))

    const buttons = screen.getAllByRole('button')
    for (const token of [' contains ""', ' startsWith ""', ' matches ""', ' in []']) {
      expect(buttons.find(button => button.getAttribute('title') === `Insert ${token} at the cursor`)).toBeVisible()
    }

    const textarea = screen.getByLabelText('Branch expression') as HTMLTextAreaElement
    textarea.focus()
    textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    const containsButton = buttons.find(button => button.getAttribute('title') === 'Insert  contains "" at the cursor')
    expect(containsButton).toBeDefined()
    fireEvent.click(containsButton!)
    expect(props.onChange).toHaveBeenCalledWith('context.input.customerTier contains ""')
  })
})

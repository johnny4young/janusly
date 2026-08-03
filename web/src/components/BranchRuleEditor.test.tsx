import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../i18n'
import type { WorkflowGraphEdge, WorkflowGraphNode } from '../types'
import { BranchRuleEditor } from './BranchRuleEditor'

const nodes = [
  { id: 'fetch', position: { x: 0, y: 0 }, data: { label: 'Fetch order', type: 'http', config: {} } },
  { id: 'gate', position: { x: 100, y: 0 }, data: { label: 'Check amount', type: 'condition', config: {} } },
] as WorkflowGraphNode[]
const edges = [{ id: 'fetch-gate', source: 'fetch', target: 'gate', data: {} }] as WorkflowGraphEdge[]

function renderEditor(overrides: Partial<Parameters<typeof BranchRuleEditor>[0]> = {}) {
  const props: Parameters<typeof BranchRuleEditor>[0] = {
    id: 'gate-rule',
    label: 'Branch expression',
    value: "context.input.priority === 'high'",
    onChange: vi.fn(),
    nodes,
    edges,
    targetNodeId: 'gate',
    mode: 'node',
    workflowInputs: {
      type: 'object',
      properties: {
        priority: { type: 'string' },
        amount: { type: 'number' },
        customer: { type: 'object', properties: { tier: { type: 'string' } } },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
    ...overrides,
  }
  return { ...render(<BranchRuleEditor {...props} />), props }
}

beforeEach(() => initI18n('en'))

describe('<BranchRuleEditor />', () => {
  it('projects a common expression into readable controls without rewriting it', () => {
    const { props } = renderEditor()
    expect(screen.getByLabelText('Run rule')).toHaveValue('simple')
    expect(screen.getByLabelText('Value from')).toHaveValue('context.input.priority')
    expect(screen.getByRole('option', { name: 'context.input.priority' })).toBeVisible()
    expect(screen.queryByRole('option', { name: 'context.input.customer' })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'context.input.tags' })).not.toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'context.input.customer.tier' })).toBeVisible()
    expect(screen.getByRole('option', { name: 'context.input.tags[0]' })).toBeVisible()
    expect(screen.getByLabelText('Condition')).toHaveValue('===')
    expect(screen.getByLabelText('Compare with')).toHaveValue('high')
    expect(props.onChange).not.toHaveBeenCalled()
  })

  it('emits the exact deterministic expression while editing a guided rule', () => {
    const { props } = renderEditor()
    fireEvent.change(screen.getByLabelText('Condition'), { target: { value: '!==' } })
    expect(props.onChange).toHaveBeenLastCalledWith("context.input.priority !== 'high'")
    fireEvent.change(screen.getByLabelText('Compare with'), { target: { value: 'low' } })
    expect(props.onChange).toHaveBeenLastCalledWith("context.input.priority !== 'low'")
  })

  it('uses typed graph metadata for a safe first rule', () => {
    const { props } = renderEditor({ value: 'true' })
    fireEvent.change(screen.getByLabelText('Run rule'), { target: { value: 'simple' } })
    expect(screen.getByLabelText('Value from')).toHaveValue('context.fetch.output.ok')
    expect(screen.getByLabelText('Compare with')).toHaveValue('true')
    expect(props.onChange).toHaveBeenLastCalledWith('context.fetch.output.ok === true')
  })

  it('keeps a new empty graph editable without inventing operational data', () => {
    const { props } = renderEditor({
      value: 'true',
      nodes: [{ id: 'gate', position: { x: 0, y: 0 }, data: { label: '', type: 'condition', config: {} } }],
      edges: [],
      workflowInputs: undefined,
    })
    fireEvent.change(screen.getByLabelText('Run rule'), { target: { value: 'simple' } })
    expect(screen.getByLabelText('Value from')).toHaveValue('context.input.value')
    expect(screen.getByRole('option', { name: 'context.input.value' })).toBeVisible()
    expect(props.onChange).toHaveBeenLastCalledWith("context.input.value === ''")
  })

  it('preserves compound expressions behind the advanced editor', () => {
    const expression = "context.input.priority === 'high' && context.input.amount >= 100"
    const { props } = renderEditor({ value: expression })
    expect(screen.getByLabelText('Run rule')).toHaveValue('advanced')
    expect(screen.getByLabelText('Branch expression')).toHaveValue(expression)
    expect(props.onChange).not.toHaveBeenCalled()
  })

  it('surfaces malformed advanced expressions without echoing parser internals', () => {
    renderEditor({ value: 'process.exit()' })
    expect(screen.getByLabelText('Run rule')).toHaveValue('advanced')
    expect(screen.getByRole('alert'))
      .toHaveTextContent('The expression does not match the supported runtime grammar.')
  })

  it('keeps an expression exact when its source stops being reachable', () => {
    const expression = 'context.fetch.output.statusCode >= 200'
    const view = renderEditor({ value: expression })
    view.rerender(
      <BranchRuleEditor
        {...view.props}
        nodes={[nodes[1]!]}
        edges={[]}
      />,
    )

    expect(screen.getByLabelText('Run rule')).toHaveValue('advanced')
    expect(screen.getByLabelText('Branch expression')).toHaveValue(expression)
    expect(screen.getByRole('alert')).toHaveTextContent('Not reachable here')
    expect(view.props.onChange).not.toHaveBeenCalled()
  })

  it('lets an edge remain unconditional or explicitly become a guided rule', () => {
    const { props } = renderEditor({
      value: '',
      mode: 'edge',
      targetNodeId: 'gate',
    })
    expect(screen.getByLabelText('Run rule')).toHaveValue('always')

    fireEvent.change(screen.getByLabelText('Run rule'), { target: { value: 'simple' } })
    expect(props.onChange).toHaveBeenLastCalledWith('context.gate.output.result === true')
  })

  it('localizes the guided rule in Spanish while preserving the durable expression', () => {
    initI18n('es')
    renderEditor({ value: 'context.fetch.output.statusCode >= 200' })
    expect(screen.getByLabelText('Regla de ejecución')).toHaveValue('simple')
    expect(screen.getByRole('option', { name: 'context.fetch.output.statusCode' })).toBeVisible()
    expect(screen.getByLabelText('Condición')).toHaveValue('>=')
    expect(screen.getByLabelText('Comparar con')).toHaveValue(200)
  })
})

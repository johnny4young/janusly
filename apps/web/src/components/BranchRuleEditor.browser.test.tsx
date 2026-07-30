import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { beforeAll, describe, expect, it } from 'vitest'
import { initI18n } from '../i18n'
import type { WorkflowGraphEdge, WorkflowGraphNode } from '../types'
import { BranchRuleEditor } from './BranchRuleEditor'

const nodes = [
  { id: 'fetch', position: { x: 0, y: 0 }, data: { label: 'Fetch order', type: 'http', config: {} } },
  { id: 'gate', position: { x: 100, y: 0 }, data: { label: 'Check order', type: 'condition', config: {} } },
] as WorkflowGraphNode[]
const edges = [{ id: 'fetch-gate', source: 'fetch', target: 'gate', data: {} }] as WorkflowGraphEdge[]

function Fixture() {
  const [expression, setExpression] = useState('context.fetch.output.statusCode >= 200')
  return (
    <div style={{ width: 420, padding: 20 }}>
      <BranchRuleEditor
        id="browser-rule"
        label="Branch expression"
        value={expression}
        onChange={setExpression}
        nodes={nodes}
        edges={edges}
        targetNodeId="gate"
        mode="node"
      />
      <output data-testid="expression-output">{expression}</output>
    </div>
  )
}

beforeAll(() => initI18n('en'))

describe('<BranchRuleEditor /> browser smoke', () => {
  it('keeps guided controls aligned and preserves advanced editing in Chromium', () => {
    render(<Fixture />)

    const source = screen.getByLabelText('Value from')
    const operator = screen.getByLabelText('Condition')
    const compareValue = screen.getByLabelText('Compare with')
    const fields = [source, operator, compareValue]
      .map(field => field.getBoundingClientRect())
    expect(fields.every(({ width, height }) => width > 0 && height > 0)).toBe(true)
    expect(Math.max(...fields.map(({ left }) => left)) - Math.min(...fields.map(({ left }) => left)))
      .toBeLessThanOrEqual(1)
    expect(Math.max(...fields.map(({ right }) => right)) - Math.min(...fields.map(({ right }) => right)))
      .toBeLessThanOrEqual(1)

    fireEvent.change(operator, { target: { value: '>' } })
    fireEvent.change(compareValue, { target: { value: '299' } })
    expect(screen.getByTestId('expression-output'))
      .toHaveTextContent('context.fetch.output.statusCode > 299')

    fireEvent.change(screen.getByLabelText('Run rule'), { target: { value: 'advanced' } })
    const advanced = screen.getByLabelText('Branch expression')
    expect(advanced).toHaveValue('context.fetch.output.statusCode > 299')
    expect(advanced.getBoundingClientRect().height).toBeGreaterThan(0)
  })
})

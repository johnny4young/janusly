import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowGraphEdge, WorkflowGraphNode } from '../types'
import { useWorkflowStore } from '../store'
import { AuthoringProblemsPanel } from './AuthoringProblemsPanel'
import { ExpressionAssistant } from './ExpressionAssistant'

const nodes = [
  { id: 'fetch', position: { x: 0, y: 0 }, data: { label: '', type: 'http', config: {} } },
  { id: 'gate', position: { x: 120, y: 0 }, data: { label: '', type: 'condition', config: {} } },
] as WorkflowGraphNode[]
const edges = [{ id: 'fetch-gate', source: 'fetch', target: 'gate', data: {} }] as WorkflowGraphEdge[]

function GuidanceFixture() {
  const [expression, setExpression] = useState('context.fetch.output.ok === true')
  return (
    <div style={{ width: 420, padding: 20 }}>
      <AuthoringProblemsPanel
        validationIssues={[{ code: 'condition_invalid_expression', message: 'Condition needs attention', nodeId: 'gate' }]}
        readiness={{ status: 'warn', issues: [{ code: 'workflow_missing_outputs', severity: 'warn', message: 'No outputs' }] }}
        aiReviewIssues={[]}
        workflowEdges={edges}
        onValidate={vi.fn(async () => false)}
      />
      <ExpressionAssistant
        id="browser-expression"
        label="Branch expression"
        value={expression}
        onChange={setExpression}
        nodes={nodes}
        edges={edges}
        targetNodeId="gate"
        mode="node"
      />
    </div>
  )
}

describe('guided authoring surfaces (browser)', () => {
  beforeEach(() => {
    useWorkflowStore.setState({ selectedNodeId: null, selectedEdgeId: null, activeTab: 'inspector' })
  })

  it('renders actionable Problems and inserts reachable context in Chromium', () => {
    render(<GuidanceFixture />)
    const problems = screen.getByTestId('authoring-problems')
    expect(problems.getBoundingClientRect().height).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Open problem on step gate' }))
    expect(useWorkflowStore.getState().selectedNodeId).toBe('gate')

    fireEvent.click(screen.getByRole('button', { name: 'Use context' }))
    const token = screen.getByRole('button', { name: 'Insert context.fetch.output.statusCode at the cursor' })
    expect(token.getBoundingClientRect().height).toBeGreaterThan(0)
    const expression = screen.getByLabelText('Branch expression') as HTMLTextAreaElement
    expression.focus()
    expression.setSelectionRange(expression.value.length, expression.value.length)
    fireEvent.click(token)
    expect(expression).toHaveValue('context.fetch.output.ok === truecontext.fetch.output.statusCode')
  })
})

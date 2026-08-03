import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowGraphEdge, WorkflowGraphNode } from '../types'
import { useWorkflowStore } from '../store'
import { AuthoringProblemsPanel } from './AuthoringProblemsPanel'
import { BranchRuleEditor } from './BranchRuleEditor'

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
      <BranchRuleEditor
        id="browser-expression"
        label="Branch expression"
        value={expression}
        onChange={setExpression}
        nodes={nodes}
        edges={edges}
        targetNodeId="gate"
        mode="node"
      />
      <output>{expression}</output>
    </div>
  )
}

describe('guided authoring surfaces (browser)', () => {
  beforeEach(() => {
    useWorkflowStore.setState({ selectedNodeId: null, selectedEdgeId: null, activeTab: 'inspector' })
  })

  it('renders actionable Problems and offers reachable context in Chromium', () => {
    render(<GuidanceFixture />)
    const problems = screen.getByTestId('authoring-problems')
    expect(problems.getBoundingClientRect().height).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Open problem on step gate' }))
    expect(useWorkflowStore.getState().selectedNodeId).toBe('gate')

    const source = screen.getByLabelText('Value from')
    expect(source.getBoundingClientRect().height).toBeGreaterThan(0)
    expect(screen.getByRole('option', { name: 'context.fetch.output.statusCode' })).toBeVisible()
    fireEvent.change(source, { target: { value: 'context.fetch.output.statusCode' } })
    expect(screen.getByLabelText('Compare with')).toHaveValue(200)
    expect(screen.getByText('context.fetch.output.statusCode === 200')).toBeVisible()
  })
})

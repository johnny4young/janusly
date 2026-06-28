import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReviewFindings, WorkflowDefinition } from '../types'
import { useWorkflowStore } from '../store'
import { AiCopilotPanel } from './AiCopilotPanel'

const initialState = useWorkflowStore.getState()

function renderPanel() {
  const props = {
    health: null,
    workflowName: 'My flow',
    onGenerateWorkflow: vi.fn(async () => ({
      mode: 'ai' as const,
      workflow: { name: 'ZZGENERATED', nodes: [], edges: [] } as unknown as WorkflowDefinition,
    })),
    onExplainWorkflow: vi.fn(async () => ({ mode: 'ai' as const, explanation: 'EXPLAIN_BODY_XYZ' })),
    onReviewWorkflow: vi.fn(async () => ({
      mode: 'ai' as const,
      review: { status: 'pass', issues: [] } as unknown as ReviewFindings,
    })),
    onOpenRuns: vi.fn(),
    onOpenTemplates: vi.fn(),
  }
  return render(<AiCopilotPanel {...props} />)
}

describe('<AiCopilotPanel /> result clearing on workflow switch', () => {
  beforeEach(() => {
    useWorkflowStore.setState({ ...initialState, currentWorkflowId: 'wf_1' }, true)
  })

  it('clears a stale explain result when the active workflow changes', async () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /Explain this flow/i }))
    await waitFor(() => expect(screen.getByText('EXPLAIN_BODY_XYZ')).toBeInTheDocument())

    // Operator switches to another workflow → the prior flow's analysis clears.
    act(() => { useWorkflowStore.setState({ currentWorkflowId: 'wf_2' }) })
    expect(screen.queryByText('EXPLAIN_BODY_XYZ')).not.toBeInTheDocument()
  })

  it('keeps a freshly generated draft across the workflow-id change that generating causes', async () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /Draft flow/i }))
    await waitFor(() => expect(screen.getByText(/ZZGENERATED/)).toBeInTheDocument())

    // Generating swaps the active workflow id (hydrateWorkflow) — the draft must survive.
    act(() => { useWorkflowStore.setState({ currentWorkflowId: 'wf_generated' }) })
    expect(screen.getByText(/ZZGENERATED/)).toBeInTheDocument()
  })
})

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReviewFindings, WorkflowDefinition } from '../types'
import { changeAppLanguage } from '../i18n'
import { useWorkflowStore } from '../store'
import { AiCopilotPanel } from './AiCopilotPanel'

const initialState = useWorkflowStore.getState()

type GenerateWorkflow = Parameters<typeof AiCopilotPanel>[0]['onGenerateWorkflow']
type AiCopilotProps = Parameters<typeof AiCopilotPanel>[0]

function renderPanel(onGenerateWorkflow: GenerateWorkflow = vi.fn(async () => ({
  mode: 'ai' as const,
  workflow: { name: 'ZZGENERATED', nodes: [], edges: [] } as unknown as WorkflowDefinition,
})), overrides: Partial<AiCopilotProps> = {}) {
  const props: AiCopilotProps = {
    health: null,
    workflowName: 'My flow',
    onGenerateWorkflow,
    onExplainWorkflow: vi.fn(async () => ({ mode: 'ai' as const, explanation: 'EXPLAIN_BODY_XYZ' })),
    onReviewWorkflow: vi.fn(async () => ({
      mode: 'ai' as const,
      review: { status: 'pass', issues: [] } as unknown as ReviewFindings,
    })),
    actionRequest: null,
    onSuggestWorkflowImprovement: vi.fn(async () => ({ mode: 'fallback' as const, suggestions: [] })),
    onApplyWorkflowImprovement: vi.fn(async () => true),
    onOpenRuns: vi.fn(),
    onOpenTemplates: vi.fn(),
    ...overrides,
  }
  return render(<AiCopilotPanel {...props} />)
}

describe('<AiCopilotPanel />', () => {
  beforeEach(() => {
    changeAppLanguage('en')
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

  it('explains when the AI budget warning reduces Best-of-N candidates', async () => {
    renderPanel(vi.fn(async () => ({
      mode: 'ai' as const,
      workflow: { name: 'Budget-aware flow', nodes: [], edges: [] } as unknown as WorkflowDefinition,
      bonBackoff: { from: 4, to: 1 },
    })))

    fireEvent.click(screen.getByRole('button', { name: /Draft flow/i }))

    const notice = await screen.findByTestId('ai-candidate-backoff')
    expect(notice).toHaveAttribute('role', 'status')
    expect(notice).toHaveTextContent('Budget-aware generation.')
    expect(notice).toHaveTextContent('evaluated 1 of 4 candidates')
  })

  it('uses the supported Anthropic provider in degraded-mode guidance', async () => {
    renderPanel(vi.fn(async () => ({
      mode: 'fallback' as const,
      workflow: { name: 'Fallback flow', nodes: [], edges: [] } as unknown as WorkflowDefinition,
      aiError: 'insufficient_quota',
    })))

    fireEvent.click(screen.getByRole('button', { name: /Draft flow/i }))

    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent('Anthropic account has no available credits')
    expect(status).not.toHaveTextContent('OpenAI')
  })

  it('renders results inside a persistent aria-live region so they are announced', async () => {
    const { container } = renderPanel()
    // The live region is always mounted (not conditional), so a result appearing
    // inside it is announced to screen readers.
    const live = container.querySelector('.ai-copilot__results')
    expect(live).not.toBeNull()
    expect(live).toHaveAttribute('aria-live', 'polite')

    fireEvent.click(screen.getByRole('button', { name: /Explain this flow/i }))
    await waitFor(() => expect(screen.getByText('EXPLAIN_BODY_XYZ')).toBeInTheDocument())
    expect(live).toContainElement(screen.getByText('EXPLAIN_BODY_XYZ'))
  })

  it('runs a contextual fix request and applies the chosen draft safely', async () => {
    const suggestion = {
      workflow: { id: 'fixed', name: 'Fixed flow', nodes: [], edges: [] } as WorkflowDefinition,
      rationale: 'Add a bounded recovery path.',
      approachLabel: 'add_retry',
      confidence: 0.91,
    }
    const onSuggestWorkflowImprovement = vi.fn(async () => ({
      mode: 'ai' as const,
      suggestions: [suggestion],
    }))
    const onApplyWorkflowImprovement = vi.fn(async () => true)

    renderPanel(undefined, {
      actionRequest: { id: 1, action: 'fix' },
      onSuggestWorkflowImprovement,
      onApplyWorkflowImprovement,
    })

    expect(await screen.findByText('Add a bounded recovery path.')).toBeInTheDocument()
    expect(onSuggestWorkflowImprovement).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Apply to draft' }))
    expect(onApplyWorkflowImprovement).toHaveBeenCalledWith(suggestion)
  })

  it('renders the supported Anthropic setup guidance in English local mode', () => {
    renderPanel()

    expect(screen.getByText(/Add ANTHROPIC_API_KEY to the root \.env/i)).toBeInTheDocument()
    expect(screen.getByText('Root .env has ANTHROPIC_API_KEY')).toBeInTheDocument()
    expect(screen.queryByText(/OPENAI_API_KEY/i)).not.toBeInTheDocument()
  })

  it('renders the supported Anthropic setup guidance in Spanish local mode', async () => {
    changeAppLanguage('es')
    renderPanel()

    expect(await screen.findByText(/Agrega ANTHROPIC_API_KEY al archivo \.env de la raíz/i)).toBeInTheDocument()
    expect(screen.getByText('El archivo .env de la raíz contiene ANTHROPIC_API_KEY')).toBeInTheDocument()
    expect(screen.queryByText(/OPENAI_API_KEY/i)).not.toBeInTheDocument()
  })
})

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AuthoringCapabilityCatalog,
  ReviewFindings,
  WorkflowBriefCompilation,
  WorkflowDefinition,
  WorkflowProposalResponse,
} from '../types'
import { changeAppLanguage } from '../i18n'
import { useWorkflowStore } from '../store'
import { AiStudioPanel } from './AiStudioPanel'

const initialState = useWorkflowStore.getState()
type AiStudioProps = Parameters<typeof AiStudioPanel>[0]

const catalog: AuthoringCapabilityCatalog = {
  schemaVersion: '1',
  version: 'catalog-v1',
  builtinTools: [{
    name: 'http.request',
    description: 'Bounded HTTP request',
    inputFields: [],
    required: ['url'],
    optional: [],
    writeSide: false,
  }],
  mcpTools: [],
  triggers: [{ id: 'manual', requiredConfig: [] }],
  credentials: [],
  subworkflows: [],
  primitives: [{ nodeType: 'transform', notes: 'Local transform', requiredConfig: [] }],
  warnings: [],
}

const compilation: WorkflowBriefCompilation = {
  mode: 'deterministic',
  complete: true,
  clarifyingQuestions: [],
  brief: {
    version: '1',
    objective: 'Route high-risk refunds for approval',
    trigger: 'manual',
    inputs: ['refund'],
    expectedOutcome: 'An approved refund decision',
    externalEffects: ['refund'],
    approvals: ['finance'],
    failurePolicy: 'stop and notify',
    examples: ['refund 42'],
    language: 'en',
  },
}

function workflowProposal(overrides: Partial<WorkflowProposalResponse> = {}): WorkflowProposalResponse {
  return {
    mode: 'ai',
    brief: compilation.brief,
    clarifyingQuestions: [],
    bindings: {
      catalogVersion: catalog.version,
      resolved: [{
        kind: 'tool',
        nodeId: 'check',
        field: 'tool',
        requested: 'http.request',
        resolvedId: 'http.request',
        alternatives: [],
      }],
      missing: [],
      complete: true,
    },
    proposal: {
      workflow: {
        dslVersion: '1.0',
        id: 'wf_proposed',
        name: 'Refund assurance',
        nodes: [{ id: 'check', type: 'tool', config: { tool: 'http.request' } }],
        edges: [],
        outputs: { result: '{{context.check.output}}' },
        recovery: {
          circuitBreaker: 3,
          contract: {
            version: '2',
            failure: {
              technical: { terminalNodeFailure: true, stalledNode: true },
              semantic: { mode: 'deterministic', detectors: [], evaluationFixtures: [] },
            },
          },
        },
      } as unknown as WorkflowDefinition,
      intentContract: { result: '{{context.check.output}}' },
      recoveryContract: { version: '2' },
      qualification: { intent: true, recovery: true, semantic: true },
      assumptions: ['manual_trigger'],
      risks: [],
      readiness: { status: 'pass', issues: [] },
      diff: {
        nodesAdded: ['check'],
        nodesRemoved: [],
        nodesChanged: [],
        edgesBefore: 0,
        edgesAfter: 0,
      },
      applicable: true,
    },
    ...overrides,
  }
}

function renderPanel(overrides: Partial<AiStudioProps> = {}) {
  const props: AiStudioProps = {
    health: null,
    workflowName: 'My flow',
    onLoadAuthoringCapabilities: vi.fn(async () => catalog),
    onCompileWorkflowBrief: vi.fn(async () => compilation),
    onProposeWorkflow: vi.fn(async () => workflowProposal()),
    onApplyWorkflowProposal: vi.fn(async () => true),
    onExplainWorkflow: vi.fn(async () => ({ mode: 'ai' as const, explanation: 'EXPLAIN_BODY_XYZ' })),
    onReviewWorkflow: vi.fn(async () => ({
      mode: 'ai' as const,
      review: { status: 'pass', issues: [] } as ReviewFindings,
    })),
    actionRequest: null,
    onSuggestWorkflowImprovement: vi.fn(async () => ({ mode: 'fallback' as const, suggestions: [] })),
    onApplyWorkflowImprovement: vi.fn(async () => true),
    onOpenRuns: vi.fn(),
    onOpenTemplates: vi.fn(),
    ...overrides,
  }
  return { ...render(<AiStudioPanel {...props} />), props }
}

async function compileAndPropose() {
  await screen.findByTestId('capability-catalog-summary')
  fireEvent.click(screen.getByRole('button', { name: /Compile intent brief/i }))
  await screen.findByTestId('intent-brief')
  fireEvent.click(screen.getByRole('button', { name: /Build proposal/i }))
  return await screen.findByTestId('workflow-proposal')
}

describe('<AiStudioPanel />', () => {
  beforeEach(() => {
    changeAppLanguage('en')
    useWorkflowStore.setState({ ...initialState, currentWorkflowId: 'wf_1' }, true)
  })

  it('keeps compilation, proposal, and explicit Apply as separate operations', async () => {
    const onCompileWorkflowBrief = vi.fn(async () => compilation)
    const onProposeWorkflow = vi.fn(async () => workflowProposal())
    const onApplyWorkflowProposal = vi.fn(async () => true)
    renderPanel({ onCompileWorkflowBrief, onProposeWorkflow, onApplyWorkflowProposal })

    await screen.findByTestId('capability-catalog-summary')
    fireEvent.click(screen.getByRole('button', { name: /Compile intent brief/i }))
    await screen.findByTestId('intent-brief')
    expect(onCompileWorkflowBrief).toHaveBeenCalledOnce()
    expect(onProposeWorkflow).not.toHaveBeenCalled()
    expect(onApplyWorkflowProposal).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /Build proposal/i }))
    await screen.findByTestId('workflow-proposal')
    expect(onProposeWorkflow).toHaveBeenCalledWith(compilation.brief, catalog.version)
    expect(onApplyWorkflowProposal).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /Apply proposal to draft/i }))
    await waitFor(() => expect(onApplyWorkflowProposal).toHaveBeenCalledOnce())
    expect(screen.getByText('Proposal copied to the draft')).toBeInTheDocument()
  })

  it('shows missing exact bindings and prevents Apply', async () => {
    const incomplete = workflowProposal()
    incomplete.bindings = {
      catalogVersion: catalog.version,
      resolved: [],
      missing: [{
        kind: 'tool',
        nodeId: 'send',
        field: 'tool',
        requested: 'crm.super_power',
        alternatives: ['http.request'],
        reason: 'capability_not_found',
      }],
      complete: false,
    }
    incomplete.proposal.applicable = false
    const onApplyWorkflowProposal = vi.fn(async () => true)
    renderPanel({
      onProposeWorkflow: vi.fn(async () => incomplete),
      onApplyWorkflowProposal,
    })

    await compileAndPropose()
    expect(screen.getByText('crm.super_power')).toBeInTheDocument()
    expect(screen.getByText(/Available alternatives: http.request/)).toBeInTheDocument()
    expect(screen.getByText('Apply is blocked')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Apply proposal to draft/i })).toBeDisabled()
    expect(onApplyWorkflowProposal).not.toHaveBeenCalled()
  })

  it('makes provider-free fallback explicit without blocking the proposal', async () => {
    renderPanel({
      onProposeWorkflow: vi.fn(async () => workflowProposal({
        mode: 'fallback',
        aiError: 'insufficient_quota',
      })),
    })

    await compileAndPropose()
    expect(screen.getByText('Deterministic local proposal')).toBeInTheDocument()
    expect(screen.getByText(/Anthropic account has no available credits/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Apply proposal to draft/i })).toBeEnabled()
  })

  it('distinguishes a guarded provider draft from the zero-call local fallback', async () => {
    const guarded = workflowProposal({ mode: 'fallback', providerGuarded: true })
    guarded.bindings = {
      catalogVersion: catalog.version,
      resolved: [],
      missing: [{
        kind: 'provider_output',
        nodeId: '',
        field: 'workflow',
        alternatives: [],
        reason: 'unsafe_provider_capability_reference',
      }],
      complete: false,
    }
    guarded.proposal.applicable = false
    guarded.proposal.risks = ['provider_output_guarded', 'missing_capability_binding']
    renderPanel({ onProposeWorkflow: vi.fn(async () => guarded) })

    await compileAndPropose()
    expect(screen.getByTestId('provider-output-guarded')).toHaveTextContent('Unsafe AI draft replaced locally')
    expect(screen.getByTestId('provider-output-guarded')).toHaveTextContent('Janusly discarded that graph')
    expect(screen.queryByText('No external AI call was required.')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Assumptions and risks'))
    expect(screen.getByText(/provider graph was discarded because it contained a tool/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Apply proposal to draft/i })).toBeDisabled()
  })

  it('renders no more than three clarifying questions', async () => {
    renderPanel({
      onCompileWorkflowBrief: vi.fn(async () => ({
        ...compilation,
        clarifyingQuestions: ['Question one?', 'Question two?', 'Question three?', 'Question four?'],
      })),
    })

    await screen.findByTestId('capability-catalog-summary')
    fireEvent.click(screen.getByRole('button', { name: /Compile intent brief/i }))
    expect(await screen.findByText('Question one?')).toBeInTheDocument()
    expect(screen.getByText('Question two?')).toBeInTheDocument()
    expect(screen.getByText('Question three?')).toBeInTheDocument()
    expect(screen.queryByText('Question four?')).not.toBeInTheDocument()
  })

  it('shows all executable assurance contracts in a proposal', async () => {
    await compileAndProposeAfterRender()
    const summary = screen.getByTestId('workflow-assurance-summary')
    expect(summary).toHaveTextContent('Intent contract')
    expect(summary).toHaveTextContent('Recovery contract')
    expect(summary).toHaveTextContent('Qualification contract')
  })

  it('invalidates a proposal and analysis when the active workflow changes', async () => {
    renderPanel()
    await compileAndPropose()
    fireEvent.click(screen.getByRole('button', { name: /Explain this flow/i }))
    await screen.findByText('EXPLAIN_BODY_XYZ')

    act(() => { useWorkflowStore.setState({ currentWorkflowId: 'wf_2' }) })
    expect(screen.queryByTestId('workflow-proposal')).not.toBeInTheDocument()
    expect(screen.queryByText('EXPLAIN_BODY_XYZ')).not.toBeInTheDocument()
  })

  it('keeps async results inside a persistent aria-live region', async () => {
    const { container } = renderPanel()
    const live = container.querySelector('.ai-ai-studio__results')
    expect(live).not.toBeNull()
    expect(live).toHaveAttribute('aria-live', 'polite')

    fireEvent.click(screen.getByRole('button', { name: /Explain this flow/i }))
    await waitFor(() => expect(screen.getByText('EXPLAIN_BODY_XYZ')).toBeInTheDocument())
    expect(live).toContainElement(screen.getByText('EXPLAIN_BODY_XYZ'))
  })

  it('runs a contextual fix request and applies the chosen improvement separately', async () => {
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

    renderPanel({
      actionRequest: { id: 1, action: 'fix' },
      onSuggestWorkflowImprovement,
      onApplyWorkflowImprovement,
    })

    expect(await screen.findByText('Add a bounded recovery path.')).toBeInTheDocument()
    expect(onSuggestWorkflowImprovement).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Apply to draft' }))
    expect(onApplyWorkflowImprovement).toHaveBeenCalledWith(suggestion)
  })

  it('renders the supported Anthropic setup guidance in English and Spanish', async () => {
    renderPanel()
    expect(screen.getByText(/Configure ANTHROPIC_API_KEY for the API and worker/i)).toBeInTheDocument()
    expect(screen.getByText('Root .env has ANTHROPIC_API_KEY')).toBeInTheDocument()
    expect(screen.queryByText(/OPENAI_API_KEY/i)).not.toBeInTheDocument()

    await act(async () => { await changeAppLanguage('es') })
    expect(screen.getByText(/Configura ANTHROPIC_API_KEY para la API y el worker/i)).toBeInTheDocument()
    expect(screen.getByText('El archivo .env de la raíz contiene ANTHROPIC_API_KEY')).toBeInTheDocument()
    expect(screen.getAllByText('Brief de intención')).not.toHaveLength(0)
    expect(screen.queryByText('Root .env has ANTHROPIC_API_KEY')).not.toBeInTheDocument()
  })
})

async function compileAndProposeAfterRender() {
  renderPanel()
  return await compileAndPropose()
}

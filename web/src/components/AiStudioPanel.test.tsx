import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AuthoringCapabilityCatalog,
  ReviewFindings,
  WorkflowBriefCompilation,
  WorkflowDefinition,
  WorkflowProposalApplyOutcome,
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
    onApplyWorkflowProposal: vi.fn(async () => ({ status: 'applied' as const })),
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
    const onApplyWorkflowProposal = vi.fn(async () => ({ status: 'applied' as const }))
    renderPanel({ onCompileWorkflowBrief, onProposeWorkflow, onApplyWorkflowProposal })

    await screen.findByTestId('capability-catalog-summary')
    const sourcePrompt = (screen.getByLabelText('Business intent') as HTMLTextAreaElement).value
    fireEvent.click(screen.getByRole('button', { name: /Compile intent brief/i }))
    await screen.findByTestId('intent-brief')
    expect(onCompileWorkflowBrief).toHaveBeenCalledOnce()
    expect(onProposeWorkflow).not.toHaveBeenCalled()
    expect(onApplyWorkflowProposal).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /Build proposal/i }))
    await screen.findByTestId('workflow-proposal')
    expect(onProposeWorkflow).toHaveBeenCalledWith(compilation.brief, catalog.version, sourcePrompt)
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
    const onApplyWorkflowProposal = vi.fn(async () => ({ status: 'applied' as const }))
    renderPanel({
      onProposeWorkflow: vi.fn(async () => incomplete),
      onApplyWorkflowProposal,
    })

    await compileAndPropose()
    expect(screen.getByText('crm.super_power')).toBeInTheDocument()
    expect(screen.getByText(/Available alternatives: http.request/)).toBeInTheDocument()
    expect(screen.getByText(/Add the missing details to the business intent/i)).toBeInTheDocument()
    expect(screen.getByText('Apply is blocked')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Apply proposal to draft/i })).toBeDisabled()
    expect(onApplyWorkflowProposal).not.toHaveBeenCalled()
  })

  it('surfaces a catalog change returned by the final Apply boundary', async () => {
    const changedCatalog: AuthoringCapabilityCatalog = {
      ...catalog,
      version: 'catalog-v2',
    }
    const onLoadAuthoringCapabilities = vi.fn(async () => catalog)
    const onApplyWorkflowProposal = vi.fn(async () => ({
      status: 'catalog_changed' as const,
      catalog: changedCatalog,
    }))
    renderPanel({ onLoadAuthoringCapabilities, onApplyWorkflowProposal })

    await compileAndPropose()
    fireEvent.click(screen.getByRole('button', { name: /Apply proposal to draft/i }))

    expect(await screen.findByText('Apply is blocked')).toBeInTheDocument()
    expect(screen.getByText(/compile it again/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Apply proposal to draft/i })).toBeDisabled()
    expect(onLoadAuthoringCapabilities).toHaveBeenCalledOnce()
    expect(onApplyWorkflowProposal).toHaveBeenCalledOnce()
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

  it('shows bounded local time-to-value evidence without claiming execution', async () => {
    renderPanel({
      onProposeWorkflow: vi.fn(async () => workflowProposal({ mode: 'fallback' })),
    })

    await compileAndPropose()
    const preview = screen.getByTestId('authoring-value-preview')
    expect(preview).toHaveTextContent('Controlled evidence')
    expect(preview).toHaveTextContent('Deterministic local proposal')
    expect(preview).toHaveTextContent('Executable assurance:')
    expect(preview).toHaveTextContent('3/3')
    expect(preview).toHaveTextContent(/still unsaved and has not been validated or executed/i)
  })

  it('shows exact configured defaults before the proposal touches the canvas', async () => {
    const configured = workflowProposal({ mode: 'fallback' })
    configured.proposal.workflow.inputs = {
      type: 'object',
      properties: {
        timeZone: {
          type: 'string',
          description: 'IANA timezone used for the on-call window.',
          default: 'America/Bogota',
        },
        activeUntil: {
          type: 'string',
          description: 'Exclusive end of the finite automation campaign.',
          default: '2026-09-08T10:04:05-05:00',
        },
        operatorNote: { type: 'string' },
      },
    }
    renderPanel({
      onProposeWorkflow: vi.fn(async () => configured),
    })

    await compileAndPropose()
    fireEvent.click(screen.getByText('Inputs (2)'))

    expect(screen.getByText('America/Bogota')).toBeVisible()
    expect(screen.getByText('2026-09-08T10:04:05-05:00')).toBeVisible()
    expect(screen.getByText('Exclusive end of the finite automation campaign.')).toBeVisible()
    expect(screen.queryByText('operatorNote')).toBeNull()
  })

  it('counts exact built-in, MCP, and HTTP writes in the operational preview', async () => {
    const writeCatalog: AuthoringCapabilityCatalog = {
      ...catalog,
      builtinTools: [
        ...catalog.builtinTools,
        {
          name: 'slack.post', description: 'Post to Slack', inputFields: [],
          required: ['credential'], optional: [], writeSide: true,
        },
      ],
      mcpTools: [{
        connectionAlias: 'crm', toolName: 'contacts.update', description: 'Update a contact',
        inputFields: [], writeSide: true,
      }],
    }
    const writeProposal = workflowProposal({ mode: 'fallback' })
    writeProposal.proposal.workflow.nodes = [
      { id: 'slack', type: 'tool', config: { tool: 'slack.post' } },
      { id: 'crm', type: 'mcp_tool', config: { connectionAlias: 'crm', toolName: 'contacts.update' } },
      { id: 'post', type: 'http', config: { url: 'https://example.test', method: 'POST' } },
      { id: 'read', type: 'http', config: { url: 'https://example.test', method: 'GET' } },
    ] as WorkflowDefinition['nodes']
    renderPanel({
      onLoadAuthoringCapabilities: vi.fn(async () => writeCatalog),
      onProposeWorkflow: vi.fn(async () => writeProposal),
    })

    await compileAndPropose()
    expect(screen.getByTestId('authoring-value-preview')).toHaveTextContent(/External effects\s*3/)
  })

  it('opens with the flagship PagerDuty assurance example', async () => {
    renderPanel()
    await screen.findByTestId('capability-catalog-summary')
    expect(screen.getByLabelText('Business intent')).toHaveValue(
      'Starting now for one week, acknowledge PagerDuty incidents assigned to PUSER1 outside 09:00–17:00 America/Bogota and snooze them for 12 hours as operator@example.com.',
    )
  })

  it('localizes the untouched starter without replacing operator input', async () => {
    renderPanel()
    await screen.findByTestId('capability-catalog-summary')

    await act(async () => { await changeAppLanguage('es') })
    const intent = screen.getByLabelText('Intención de negocio')
    expect(intent).toHaveValue(
      'Desde ahora y durante una semana, reconoce incidentes de PagerDuty asignados a PUSER1 fuera de 09:00–17:00 America/Bogota y aplázalos 12 horas como operator@example.com.',
    )

    fireEvent.change(intent, { target: { value: 'Mi intención PagerDuty exacta' } })
    await act(async () => { await changeAppLanguage('en') })
    expect(screen.getByLabelText('Business intent')).toHaveValue('Mi intención PagerDuty exacta')
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
    expect(screen.getByTestId('provider-output-guarded')).toHaveTextContent('Janusly replaced it with a safe incomplete draft')
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

  it('lets the operator answer bounded clarification questions before recompiling', async () => {
    const incompleteCompilation: WorkflowBriefCompilation = {
      ...compilation,
      complete: false,
      clarifyingQuestions: ['What exact time range may Janusly act within?'],
    }
    const onCompileWorkflowBrief = vi.fn()
      .mockResolvedValueOnce(incompleteCompilation)
      .mockResolvedValueOnce(compilation)
    renderPanel({ onCompileWorkflowBrief })

    await screen.findByTestId('capability-catalog-summary')
    fireEvent.click(screen.getByRole('button', { name: /Compile intent brief/i }))
    await screen.findByText('What exact time range may Janusly act within?')

    const answer = screen.getByRole('textbox', { name: 'What exact time range may Janusly act within?' })
    expect(screen.getByRole('button', { name: /Use answers and compile again/i })).toBeDisabled()
    fireEvent.change(answer, { target: { value: '09:00–17:00 America/Bogota' } })
    fireEvent.click(screen.getByRole('button', { name: /Use answers and compile again/i }))

    await waitFor(() => expect(onCompileWorkflowBrief).toHaveBeenCalledTimes(2))
    expect(onCompileWorkflowBrief.mock.calls[1]?.[0]).toContain('Clarification 1: 09:00–17:00 America/Bogota')
    expect(await screen.findByRole('button', { name: /Build proposal/i })).toBeEnabled()
  })

  it('retains every submitted answer across multiple clarification rounds', async () => {
    const onCompileWorkflowBrief = vi.fn()
      .mockResolvedValueOnce({ ...compilation, complete: false, clarifyingQuestions: ['Which time window?'] })
      .mockResolvedValueOnce({ ...compilation, complete: false, clarifyingQuestions: ['Which account?'] })
      .mockResolvedValueOnce(compilation)
    const onProposeWorkflow = vi.fn(async () => workflowProposal())
    renderPanel({ onCompileWorkflowBrief, onProposeWorkflow })

    await screen.findByTestId('capability-catalog-summary')
    const intent = screen.getByRole('textbox', { name: 'Business intent' })
    const original = (intent as HTMLTextAreaElement).value
    fireEvent.click(screen.getByRole('button', { name: /Compile intent brief/i }))
    fireEvent.change(await screen.findByRole('textbox', { name: 'Which time window?' }), {
      target: { value: '09:00–17:00 America/Bogota' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Use answers and compile again/i }))
    fireEvent.change(await screen.findByRole('textbox', { name: 'Which account?' }), {
      target: { value: 'operator@example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Use answers and compile again/i }))

    await waitFor(() => expect(onCompileWorkflowBrief).toHaveBeenCalledTimes(3))
    const submitted = onCompileWorkflowBrief.mock.calls[2]?.[0] as string
    expect(submitted).toContain(original)
    expect(submitted).toContain('09:00–17:00 America/Bogota')
    expect(submitted).toContain('operator@example.com')
    expect(intent).toHaveValue(submitted)
    fireEvent.click(await screen.findByRole('button', { name: /Build proposal/i }))
    await waitFor(() => expect(onProposeWorkflow).toHaveBeenCalledWith(compilation.brief, catalog.version, submitted))
  })

  it('refuses an oversized clarified intent without truncating constraints or losing answers', async () => {
    const onCompileWorkflowBrief = vi.fn().mockResolvedValue({
      ...compilation,
      complete: false,
      clarifyingQuestions: ['Which account?'],
    })
    renderPanel({ onCompileWorkflowBrief })

    await screen.findByTestId('capability-catalog-summary')
    const intent = screen.getByRole('textbox', { name: 'Business intent' })
    const original = `${'a'.repeat(3940)} Never write without human approval.`
    fireEvent.change(intent, { target: { value: original } })
    fireEvent.click(screen.getByRole('button', { name: /Compile intent brief/i }))
    const answer = await screen.findByRole('textbox', { name: 'Which account?' })
    const answerText = `operator@example.com ${'b'.repeat(100)}`
    fireEvent.change(answer, { target: { value: answerText } })
    fireEvent.click(screen.getByRole('button', { name: /Use answers and compile again/i }))

    expect(await screen.findByText(/The intent and answers exceed 4000 characters/)).toBeInTheDocument()
    expect(onCompileWorkflowBrief).toHaveBeenCalledTimes(1)
    expect(intent).toHaveValue(original)
    expect(answer).toHaveValue(answerText)
    expect(screen.getByTestId('intent-brief')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Build proposal/i })).toBeDisabled()
  })

  it('keeps submitted clarification text available after a compiler failure', async () => {
    const onCompileWorkflowBrief = vi.fn()
      .mockResolvedValueOnce({ ...compilation, complete: false, clarifyingQuestions: ['Which account?'] })
      .mockRejectedValueOnce(new Error('compiler unavailable'))
    renderPanel({ onCompileWorkflowBrief })

    await screen.findByTestId('capability-catalog-summary')
    fireEvent.click(screen.getByRole('button', { name: /Compile intent brief/i }))
    fireEvent.change(await screen.findByRole('textbox', { name: 'Which account?' }), {
      target: { value: 'operator@example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Use answers and compile again/i }))

    expect(await screen.findByText('compiler unavailable')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Business intent' })).toHaveValue(onCompileWorkflowBrief.mock.calls[1]?.[0])
    expect(onCompileWorkflowBrief.mock.calls[1]?.[0]).toContain('operator@example.com')
    expect(screen.queryByTestId('intent-brief')).not.toBeInTheDocument()
  })

  it('keeps proposal generation blocked while the intent needs clarification', async () => {
    const incompleteCompilation: WorkflowBriefCompilation = {
      ...compilation,
      complete: false,
      clarifyingQuestions: ['What exact time range may Janusly act within?'],
    }
    const onProposeWorkflow = vi.fn(async () => workflowProposal())
    renderPanel({
      onCompileWorkflowBrief: vi.fn(async () => incompleteCompilation),
      onProposeWorkflow,
    })

    await screen.findByTestId('capability-catalog-summary')
    fireEvent.click(screen.getByRole('button', { name: /Compile intent brief/i }))
    await screen.findByText('What exact time range may Janusly act within?')
    expect(screen.getByRole('button', { name: /Build proposal/i })).toBeDisabled()
    expect(onProposeWorkflow).not.toHaveBeenCalled()
  })

  it('clears a stale brief when recompilation fails', async () => {
    const onCompileWorkflowBrief = vi.fn()
      .mockResolvedValueOnce(compilation)
      .mockRejectedValueOnce(new Error('brief compiler unavailable'))
    renderPanel({ onCompileWorkflowBrief })

    await screen.findByTestId('capability-catalog-summary')
    const compile = screen.getByRole('button', { name: /Compile intent brief/i })
    fireEvent.click(compile)
    await screen.findByTestId('intent-brief')
    fireEvent.click(compile)

    await screen.findByText('brief compiler unavailable')
    expect(screen.queryByTestId('intent-brief')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Build proposal/i })).toBeDisabled()
  })

  it('discards a proposal that finishes after the active workflow changes', async () => {
    let resolveProposal: ((value: WorkflowProposalResponse) => void) | undefined
    const pendingProposal = new Promise<WorkflowProposalResponse>((resolve) => {
      resolveProposal = resolve
    })
    const onProposeWorkflow = vi.fn(() => pendingProposal)
    renderPanel({ onProposeWorkflow })

    await screen.findByTestId('capability-catalog-summary')
    fireEvent.click(screen.getByRole('button', { name: /Compile intent brief/i }))
    await screen.findByTestId('intent-brief')
    fireEvent.click(screen.getByRole('button', { name: /Build proposal/i }))
    await waitFor(() => expect(onProposeWorkflow).toHaveBeenCalledOnce())

    act(() => { useWorkflowStore.setState({ currentWorkflowId: 'wf_2' }) })
    await act(async () => { resolveProposal?.(workflowProposal()) })

    expect(screen.queryByTestId('workflow-proposal')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Build proposal/i })).toBeEnabled()
  })

  it('discards an Apply result after the operator switches workflows', async () => {
    let resolveApply: ((value: WorkflowProposalApplyOutcome) => void) | undefined
    const pendingApply = new Promise<WorkflowProposalApplyOutcome>((resolve) => {
      resolveApply = resolve
    })
    const onApplyWorkflowProposal = vi.fn(() => pendingApply)
    renderPanel({ onApplyWorkflowProposal })
    await compileAndPropose()

    fireEvent.click(screen.getByRole('button', { name: /Apply proposal to draft/i }))
    await waitFor(() => expect(onApplyWorkflowProposal).toHaveBeenCalledOnce())
    act(() => { useWorkflowStore.setState({ currentWorkflowId: 'wf_2' }) })
    await act(async () => { resolveApply?.({ status: 'applied' }) })

    expect(screen.queryByText('Proposal copied to the draft')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workflow-proposal')).not.toBeInTheDocument()
  })

  it('preserves Apply success when the production boundary hydrates the proposal', async () => {
    const onApplyWorkflowProposal = vi.fn(async (response: WorkflowProposalResponse) => {
      useWorkflowStore.getState().hydrateWorkflow(response.proposal.workflow, { saved: false, dirty: true })
      return { status: 'applied' as const }
    })
    renderPanel({ onApplyWorkflowProposal })
    await compileAndPropose()

    fireEvent.click(screen.getByRole('button', { name: /Apply proposal to draft/i }))

    expect(await screen.findByText('Proposal copied to the draft')).toBeInTheDocument()
    expect(useWorkflowStore.getState()).toMatchObject({
      currentWorkflowId: 'wf_proposed',
      workflowDirty: true,
      currentWorkflowSaved: false,
    })
    expect(screen.queryByTestId('workflow-proposal')).not.toBeInTheDocument()
  })

  it('clears tenant authoring data and reloads capabilities on an identity switch', async () => {
    let resolveSecondCatalog: ((value: AuthoringCapabilityCatalog) => void) | undefined
    const secondCatalog = new Promise<AuthoringCapabilityCatalog>((resolve) => {
      resolveSecondCatalog = resolve
    })
    const onLoadAuthoringCapabilities = vi.fn()
      .mockResolvedValueOnce(catalog)
      .mockImplementationOnce(() => secondCatalog)
    renderPanel({ onLoadAuthoringCapabilities })
    await compileAndPropose()

    act(() => {
      useWorkflowStore.setState({ orgId: 'org_2', userId: 'user_2' })
    })

    expect(screen.queryByTestId('capability-catalog-summary')).not.toBeInTheDocument()
    expect(screen.queryByTestId('workflow-proposal')).not.toBeInTheDocument()
    expect(screen.getByText(/Loading the exact workspace capability catalog/)).toBeInTheDocument()
    expect(screen.getByLabelText('Business intent')).toHaveValue(
      'Starting now for one week, acknowledge PagerDuty incidents assigned to PUSER1 outside 09:00–17:00 America/Bogota and snooze them for 12 hours as operator@example.com.',
    )

    await act(async () => {
      resolveSecondCatalog?.({ ...catalog, version: 'catalog-org-2' })
    })
    expect(await screen.findByTestId('capability-catalog-summary')).toBeInTheDocument()
    expect(onLoadAuthoringCapabilities).toHaveBeenCalledTimes(2)
  })

  it('discards workflow analysis that finishes after navigation', async () => {
    let resolveExplanation: ((value: { mode: 'ai'; explanation: string }) => void) | undefined
    const pendingExplanation = new Promise<{ mode: 'ai'; explanation: string }>((resolve) => {
      resolveExplanation = resolve
    })
    const onExplainWorkflow = vi.fn(() => pendingExplanation)
    renderPanel({ onExplainWorkflow })

    await screen.findByTestId('capability-catalog-summary')
    fireEvent.click(screen.getByRole('button', { name: /Explain this flow/i }))
    await waitFor(() => expect(onExplainWorkflow).toHaveBeenCalledOnce())
    act(() => { useWorkflowStore.setState({ currentWorkflowId: 'wf_2' }) })
    await act(async () => { resolveExplanation?.({ mode: 'ai', explanation: 'STALE_EXPLANATION' }) })

    expect(screen.queryByText('STALE_EXPLANATION')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Explain this flow/i })).toBeEnabled()
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

  it('invalidates a proposal when the active canvas changes in place', async () => {
    renderPanel()
    await compileAndPropose()

    act(() => {
      const current = useWorkflowStore.getState()
      useWorkflowStore.setState({ workflowRevision: current.workflowRevision + 1 })
    })

    expect(screen.queryByTestId('workflow-proposal')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Build proposal/i })).toBeEnabled()
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

  it('prefills but never submits a governed successor authoring request', async () => {
    const prompt = 'Create a qualified successor from exact version version-7.'
    const { props } = renderPanel({
      actionRequest: { id: 1, action: 'generate', prompt },
    })

    const input = await screen.findByLabelText('Business intent')
    expect(input).toHaveValue(prompt)
    expect(input).toHaveFocus()
    expect(props.onCompileWorkflowBrief).not.toHaveBeenCalled()
    expect(props.onProposeWorkflow).not.toHaveBeenCalled()
    expect(props.onApplyWorkflowProposal).not.toHaveBeenCalled()
  })

  it('renders the supported Anthropic setup guidance in English and Spanish', async () => {
    renderPanel()
    await screen.findByTestId('capability-catalog-summary')
    expect(screen.getByLabelText('Business intent')).toHaveValue(
      'Starting now for one week, acknowledge PagerDuty incidents assigned to PUSER1 outside 09:00–17:00 America/Bogota and snooze them for 12 hours as operator@example.com.',
    )
    expect(screen.getByText(/Set ANTHROPIC_API_KEY for the Janusly process/i)).toBeInTheDocument()
    expect(screen.getByText('Anthropic key configured')).toBeInTheDocument()
    expect(screen.getByText('Janusly process responding')).toBeInTheDocument()
    expect(screen.getByText(/Janusly runs the API and workers in one process/)).toBeInTheDocument()
    expect(screen.queryByText(/Restart both processes/)).not.toBeInTheDocument()
    expect(screen.queryByText(/OPENAI_API_KEY/i)).not.toBeInTheDocument()

    await act(async () => { await changeAppLanguage('es') })
    expect(screen.getByText(/Configura ANTHROPIC_API_KEY para el proceso Janusly/i)).toBeInTheDocument()
    expect(screen.getByText('Clave de Anthropic configurada')).toBeInTheDocument()
    expect(screen.getByText('El proceso Janusly responde')).toBeInTheDocument()
    expect(screen.getByText(/Janusly ejecuta la API y los workers en un solo proceso/)).toBeInTheDocument()
    expect(screen.queryByText(/Reinicia ambos procesos/)).not.toBeInTheDocument()
    expect(screen.getAllByText('Brief de intención')).not.toHaveLength(0)
    expect(screen.getByLabelText('Intención de negocio')).toHaveValue(
      'Desde ahora y durante una semana, reconoce incidentes de PagerDuty asignados a PUSER1 fuera de 09:00–17:00 America/Bogota y aplázalos 12 horas como operator@example.com.',
    )
    expect(screen.queryByText('Anthropic key configured')).not.toBeInTheDocument()
  })
})

async function compileAndProposeAfterRender() {
  renderPanel()
  return await compileAndPropose()
}

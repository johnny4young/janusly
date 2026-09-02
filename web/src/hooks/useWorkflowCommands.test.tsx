import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api, contractApi } from '../api'
import type { ApiResponse } from '../lib/api-types.generated'
import { useWorkflowStore } from '../store'
import type {
  AuthoringCapabilityCatalog,
  WorkflowDefinition,
  WorkflowProposalResponse,
} from '../types'
import type { AppCommandsOptions } from './app-command-types'
import { useWorkflowCommands } from './useWorkflowCommands'

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(async () => true),
}))

vi.mock('../api', () => ({ api: vi.fn(), contractApi: vi.fn() }))
vi.mock('../components/ConfirmDialog', () => ({
  useConfirm: () => mocks.confirm,
}))

const initialState = useWorkflowStore.getState()

const sourceWorkflow: WorkflowDefinition = {
  dslVersion: '1.0',
  id: 'workflow-1',
  name: 'Incident workflow',
  nodes: [{ id: 'done', type: 'noop', config: {} }],
  edges: [],
}

const authoringCatalog: AuthoringCapabilityCatalog = {
  schemaVersion: '1',
  version: 'catalog-v1',
  builtinTools: [],
  mcpTools: [],
  triggers: [],
  credentials: [],
  subworkflows: [],
  primitives: [],
  warnings: [],
}

function validProposal(): WorkflowProposalResponse {
  return {
    mode: 'fallback',
    brief: {
      version: '1',
      objective: 'Apply the qualified workflow',
      trigger: 'manual',
      inputs: [],
      expectedOutcome: 'The workflow completes',
      externalEffects: [],
      approvals: [],
      failurePolicy: 'stop',
      examples: [],
      language: 'en',
    },
    clarifyingQuestions: [],
    bindings: {
      catalogVersion: authoringCatalog.version,
      resolved: [],
      missing: [],
      complete: true,
    },
    proposal: {
      workflow: {
        ...sourceWorkflow,
        id: 'proposal-workflow',
        name: 'Qualified proposal',
        outputs: {},
      },
      intentContract: {},
      recoveryContract: null,
      qualification: { intent: false, recovery: false, semantic: false },
      assumptions: [],
      risks: [],
      readiness: { status: 'pass', issues: [] },
      diff: {
        nodesAdded: ['done'],
        nodesRemoved: [],
        nodesChanged: [],
        edgesBefore: 0,
        edgesAfter: 0,
      },
      applicable: true,
    },
  }
}

function options(): AppCommandsOptions {
  const state = useWorkflowStore.getState()
  return {
    store: {
      addToast: state.addToast,
      bumpPlatformVersion: state.bumpPlatformVersion,
      getWorkflowJson: state.getWorkflowJson,
      hydrateWorkflow: state.hydrateWorkflow,
      markWorkflowSaved: state.markWorkflowSaved,
      newWorkflow: state.newWorkflow,
      setActiveTab: state.setActiveTab,
      updateEdgeCondition: state.updateEdgeCondition,
      updateEdgeOnError: state.updateEdgeOnError,
    } as unknown as AppCommandsOptions['store'],
    permissions: ['workflows.read', 'workflows.write', 'ai.write'],
    projectedRuns: [],
    refreshPlatform: vi.fn(async () => undefined),
    projectRunSummary: vi.fn(),
    loadStatus: vi.fn(async () => undefined),
    runTransitionGuard: {} as AppCommandsOptions['runTransitionGuard'],
    runPlatformMutation: vi.fn() as AppCommandsOptions['runPlatformMutation'],
    setValidationIssues: vi.fn(),
    setAiReviewIssues: vi.fn(),
    setRunInputOpen: vi.fn(),
    setRunInputServerErrors: vi.fn(),
    setRunInputSubmitting: vi.fn(),
    setActivityRecoveryId: vi.fn(),
    setPaletteOpen: vi.fn(),
    setShortcutsOpen: vi.fn(),
    focusSidebarSearch: vi.fn(() => false),
    t: ((key: string) => key) as AppCommandsOptions['t'],
  }
}

beforeEach(() => {
  vi.mocked(api).mockReset()
  vi.mocked(contractApi).mockReset()
  mocks.confirm.mockReset().mockResolvedValue(true)
  useWorkflowStore.setState({
    ...initialState,
    orgId: 'org-1',
    userId: 'user-1',
    toasts: [],
  }, true)
  useWorkflowStore.getState().hydrateWorkflow({
    id: 'current-workflow',
    name: 'Current workflow',
    nodes: [],
    edges: [],
  })
})

describe('useWorkflowCommands exact workflow versions', () => {
  it('hydrates only the exact bound immutable version and updates visible provenance', async () => {
    vi.mocked(contractApi).mockResolvedValue({
      id: 'version-7',
      workflowId: 'workflow-1',
      version: 7,
      dagJson: sourceWorkflow,
    })
    const { result } = renderHook(() => useWorkflowCommands(options()))

    let opened = false
    await act(async () => {
      opened = await result.current.openWorkflowVersion(
        'workflow-1',
        'version-7',
        'ai-studio',
      )
    })

    expect(opened).toBe(true)
    expect(contractApi).toHaveBeenCalledWith(
      'GET /workflows/versions/{versionId}',
      '/workflows/versions/version-7?workflowId=workflow-1',
      undefined,
    )
    expect(useWorkflowStore.getState()).toMatchObject({
      currentWorkflowId: 'workflow-1',
      currentWorkflowName: 'Incident workflow',
      currentWorkflowSaved: true,
      currentWorkflowVersion: { id: 'version-7', version: 7 },
      workflowDirty: false,
      activeTab: 'ai-studio',
    })
  })

  it('leaves a newly edited canvas untouched when the exact read returns late', async () => {
    type ExactVersionResponse = ApiResponse<'GET /workflows/versions/{versionId}'>
    let resolveRead!: (value: ExactVersionResponse) => void
    const pendingRead = new Promise<ExactVersionResponse>(resolve => {
      resolveRead = resolve
    })
    vi.mocked(contractApi).mockImplementation((() => pendingRead) as typeof contractApi)
    const { result } = renderHook(() => useWorkflowCommands(options()))

    let openedPromise!: Promise<boolean>
    act(() => {
      openedPromise = result.current.openWorkflowVersion('workflow-1', 'version-7')
    })
    await waitFor(() => expect(contractApi).toHaveBeenCalledOnce())
    act(() => {
      useWorkflowStore.getState().setWorkflowName('Operator edit while loading')
    })
    resolveRead({
      id: 'version-7',
      workflowId: 'workflow-1',
      version: 7,
      dagJson: sourceWorkflow,
    })

    let opened = true
    await act(async () => {
      opened = await openedPromise
    })
    expect(opened).toBe(false)
    expect(useWorkflowStore.getState().currentWorkflowId).toBe('current-workflow')
    expect(useWorkflowStore.getState().currentWorkflowName).toBe('Operator edit while loading')
    expect(useWorkflowStore.getState().currentWorkflowVersion).toBeNull()
  })
})

describe('useWorkflowCommands proposal apply authority', () => {
  it('applies the synchronous snapshot even if the caller mutates its object during lazy validation', async () => {
    const proposal = validProposal()
    vi.mocked(contractApi).mockResolvedValue(authoringCatalog)
    useWorkflowStore.setState({ currentWorkflowVersion: { id: 'old-version', version: 6 } })
    const { result } = renderHook(() => useWorkflowCommands(options()))

    let applyPromise!: Promise<Awaited<ReturnType<typeof result.current.applyWorkflowProposal>>>
    act(() => {
      applyPromise = result.current.applyWorkflowProposal(proposal)
      proposal.proposal.workflow.id = 'mutated-after-apply-started'
      proposal.proposal.workflow.name = 'Mutated after Apply started'
    })

    let outcome: Awaited<typeof applyPromise> | undefined
    await act(async () => {
      outcome = await applyPromise
    })

    expect(outcome).toEqual({ status: 'applied' })
    expect(useWorkflowStore.getState()).toMatchObject({
      currentWorkflowId: 'proposal-workflow',
      currentWorkflowName: 'Qualified proposal',
      currentWorkflowVersion: null,
      workflowDirty: true,
    })
  })

  it('rejects Apply when the canvas changes during lazy proposal validation', async () => {
    const proposal = validProposal()
    vi.mocked(contractApi).mockResolvedValue(authoringCatalog)
    const { result } = renderHook(() => useWorkflowCommands(options()))

    let applyPromise!: ReturnType<typeof result.current.applyWorkflowProposal>
    act(() => {
      applyPromise = result.current.applyWorkflowProposal(proposal)
      useWorkflowStore.getState().setWorkflowName('Operator edit during lazy validation')
    })

    let outcome: Awaited<typeof applyPromise> | undefined
    await act(async () => {
      outcome = await applyPromise
    })

    expect(outcome).toEqual({ status: 'canvas_changed' })
    expect(useWorkflowStore.getState()).toMatchObject({
      currentWorkflowId: 'current-workflow',
      currentWorkflowName: 'Operator edit during lazy validation',
    })
    expect(contractApi).not.toHaveBeenCalled()
    expect(mocks.confirm).not.toHaveBeenCalled()
  })
})

describe('useWorkflowCommands canvas replacement authority', () => {
  it('does not create a new workflow over a canvas selected while confirmation is open', async () => {
    let resolveConfirm!: (confirmed: boolean) => void
    mocks.confirm.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      resolveConfirm = resolve
    }))
    useWorkflowStore.getState().setWorkflowName('Unsaved current workflow')
    const { result } = renderHook(() => useWorkflowCommands(options()))

    let createPromise!: ReturnType<typeof result.current.createNewWorkflow>
    act(() => {
      createPromise = result.current.createNewWorkflow()
    })
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce())

    act(() => {
      useWorkflowStore.getState().hydrateWorkflow({
        id: 'workflow-selected-during-confirmation',
        name: 'Selected during confirmation',
        nodes: [],
        edges: [],
      })
      resolveConfirm(true)
    })
    await act(async () => {
      await createPromise
    })

    expect(useWorkflowStore.getState()).toMatchObject({
      currentWorkflowId: 'workflow-selected-during-confirmation',
      currentWorkflowName: 'Selected during confirmation',
    })
    expect(useWorkflowStore.getState().toasts.at(-1)).toMatchObject({
      message: 'toasts.workflowOpenFailed',
      tone: 'info',
    })
  })
})

describe('useWorkflowCommands save authority', () => {
  it('does not submit a canvas changed while its validation request is in flight', async () => {
    let resolveValidation!: (value: { valid: boolean; issues: [] }) => void
    const pendingValidation = new Promise<{ valid: boolean; issues: [] }>((resolve) => {
      resolveValidation = resolve
    })
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === '/validate') return await pendingValidation
      throw new Error(`unexpected API path: ${path}`)
    })
    const { result } = renderHook(() => useWorkflowCommands(options()))

    let savePromise!: ReturnType<typeof result.current.saveWorkflow>
    act(() => {
      savePromise = result.current.saveWorkflow()
    })
    await waitFor(() => expect(api).toHaveBeenCalledWith('/validate', expect.anything()))
    act(() => {
      useWorkflowStore.getState().setWorkflowName('Edited while validation was running')
      resolveValidation({ valid: true, issues: [] })
    })
    await act(async () => {
      await savePromise
    })

    expect(api).toHaveBeenCalledTimes(1)
    expect(useWorkflowStore.getState()).toMatchObject({
      currentWorkflowName: 'Edited while validation was running',
      workflowDirty: true,
    })
  })

  it('does not mark later edits saved when an earlier save request returns', async () => {
    let resolveSave!: (value: { workflowId: string; versionId: string; version: number }) => void
    const pendingSave = new Promise<{ workflowId: string; versionId: string; version: number }>((resolve) => {
      resolveSave = resolve
    })
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === '/validate') return { valid: true, issues: [] }
      if (path === '/workflows/save') return await pendingSave
      throw new Error(`unexpected API path: ${path}`)
    })
    const { result } = renderHook(() => useWorkflowCommands(options()))

    let savePromise!: ReturnType<typeof result.current.saveWorkflow>
    act(() => {
      savePromise = result.current.saveWorkflow()
    })
    await waitFor(() => expect(api).toHaveBeenCalledWith('/workflows/save', expect.anything()))
    act(() => {
      useWorkflowStore.getState().setWorkflowName('Edited after save submission')
      resolveSave({ workflowId: 'current-workflow', versionId: 'version-8', version: 8 })
    })
    await act(async () => {
      await savePromise
    })

    expect(useWorkflowStore.getState()).toMatchObject({
      currentWorkflowName: 'Edited after save submission',
      workflowDirty: true,
    })
    expect(useWorkflowStore.getState().currentWorkflowVersion).toBeNull()
    expect(useWorkflowStore.getState().toasts.at(-1)).toMatchObject({
      message: 'toasts.savedVersion',
      tone: 'success',
    })
  })
})

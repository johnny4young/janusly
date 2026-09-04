import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { createRunTransitionGuard } from '../run-transition'
import { useWorkflowStore } from '../store'
import type { WorkflowDefinition } from '../types'
import type { AppCommandsOptions } from './app-command-types'
import { useRunCommands } from './useRunCommands'

vi.mock('../api', () => {
  const module = ({ api: vi.fn() })
  return {
    ...module,
    // Typed reads route through contractApi; delegate to the same mock so the
    // path-keyed expectations below keep working.
    contractApi: (_operation: string, path: string, _request: unknown, options?: RequestInit) =>
      options === undefined ? module.api(path) : module.api(path, options),
  }
})

const initialState = useWorkflowStore.getState()
const workflow: WorkflowDefinition = {
  dslVersion: '1.0',
  id: 'workflow-1',
  name: 'Exact workflow',
  nodes: [{ id: 'done', type: 'noop', config: {} }],
  edges: [],
}

function options(): AppCommandsOptions {
  const state = useWorkflowStore.getState()
  return {
    store: {
      addEvents: state.addEvents,
      addToast: state.addToast,
      bumpPlatformVersion: state.bumpPlatformVersion,
      currentWorkflowInputs: state.currentWorkflowInputs,
      eventsCursor: state.eventsCursor,
      eventsHasMore: state.eventsHasMore,
      runId: state.runId,
      setActiveTab: state.setActiveTab,
      setEvents: state.setEvents,
      setEventsPagination: state.setEventsPagination,
      setRunDetail: state.setRunDetail,
      setRunId: state.setRunId,
      setRunNodes: state.setRunNodes,
    } as unknown as AppCommandsOptions['store'],
    permissions: ['runs.read', 'runs.start', 'workflows.write'],
    projectedRuns: [],
    refreshPlatform: vi.fn(async () => undefined),
    projectRunSummary: vi.fn(),
    loadStatus: vi.fn(async () => undefined),
    runTransitionGuard: createRunTransitionGuard(
      () => useWorkflowStore.getState().runTransitionGeneration,
    ),
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
  vi.mocked(api).mockReset().mockResolvedValue({ runId: 'run-1' })
  useWorkflowStore.setState({
    ...initialState,
    orgId: 'org-1',
    userId: 'user-1',
    toasts: [],
  }, true)
})

describe('useRunCommands workflow version authority', () => {
  it('submits the exact immutable version only for an unchanged saved canvas', async () => {
    useWorkflowStore.getState().hydrateWorkflow(workflow, {
      version: { id: 'version-7', version: 7 },
    })
    const { result } = renderHook(() => useRunCommands(options(), {
      validateWorkflow: vi.fn(async () => true),
    }))

    await act(async () => {
      await result.current.startWorkflow()
    })

    const request = vi.mocked(api).mock.calls[0]
    expect(request[0]).toBe('/start')
    const body = JSON.parse(String(request[1]?.body)) as Record<string, unknown>
    expect(body.workflowVersionId).toBe('version-7')
    expect(body.workflow).toMatchObject({
      id: workflow.id,
      name: workflow.name,
      nodes: workflow.nodes,
      edges: workflow.edges,
    })
  })

  it('omits stale version authority after a semantic edit', async () => {
    useWorkflowStore.getState().hydrateWorkflow(workflow, {
      version: { id: 'version-7', version: 7 },
    })
    useWorkflowStore.getState().setWorkflowName('Edited draft')
    const { result } = renderHook(() => useRunCommands(options(), {
      validateWorkflow: vi.fn(async () => true),
    }))

    await act(async () => {
      await result.current.startWorkflow()
    })

    const request = vi.mocked(api).mock.calls[0]
    const body = JSON.parse(String(request[1]?.body)) as Record<string, unknown>
    expect(body.workflowVersionId).toBeUndefined()
    expect(body.workflow).toMatchObject({ id: 'workflow-1', name: 'Edited draft' })
  })
})

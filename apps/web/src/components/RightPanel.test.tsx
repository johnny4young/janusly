import { render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { RightPanel, type RightPanelProps } from './RightPanel'

vi.mock('../api', () => ({
  api: vi.fn(),
}))

function props(overrides: Partial<RightPanelProps> = {}): RightPanelProps {
  return {
    tab: 'credentials',
    authoring: {
      aiHealth: null,
      runNodes: [],
      selectedNode: null,
      selectedEdge: null,
      workflowNodes: [],
      workflowEdges: [],
      validationIssues: [],
      readinessResult: null,
      aiReviewIssues: [],
      tools: [],
      workflows: [],
      currentWorkflowId: 'untitled',
      currentWorkflowName: 'Untitled',
      onUpdateNodeConfig: vi.fn(),
      onUpdateNodeType: vi.fn(),
      onUpdateEdgeCondition: vi.fn(),
      onValidateWorkflow: vi.fn(async () => true),
      onInsertSnippet: vi.fn(),
      onGenerateWorkflow: vi.fn(async () => ({ mode: 'fallback' as const, workflow: { dslVersion: '1.0' as const, id: 'wf', name: 'Workflow', nodes: [], edges: [] } })),
      onExplainWorkflow: vi.fn(async () => ({ mode: 'fallback' as const, explanation: '' })),
      onReviewWorkflow: vi.fn(async () => ({ mode: 'fallback' as const, review: { status: 'pass' as const, issues: [] } })),
    },
    catalog: {
      tools: [],
      templates: [],
      solutionPacks: [],
      credentials: [],
      workflows: [],
      onOpenWorkflow: vi.fn(),
      onUseTemplate: vi.fn(),
      onInstallPlugin: vi.fn(),
      onInstallPack: vi.fn(),
      onSampleRunPack: vi.fn(),
      onInjectPackFailure: vi.fn(),
      onCreateCredential: vi.fn(),
    },
    execution: {
      events: [],
      runNodes: [],
      runs: [],
      workflows: [],
      usage: {},
      onOpenRun: vi.fn(),
      onRefreshPlatform: vi.fn(),
      onApproveNode: vi.fn(),
      onSubmitHumanForm: vi.fn(),
      onReplayNode: vi.fn(),
      onRedriveNode: vi.fn(),
      onReplayDeadLetter: vi.fn(),
      onResolveDeadLetter: vi.fn(),
    },
    navigation: { onOpenTab: vi.fn() },
    ...overrides,
  }
}

beforeEach(() => {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockResolvedValue({ credentials: [] })
})

describe('<RightPanel /> credentials', () => {
  it('offers postgres as a connection kind for external DB tools', () => {
    render(<RightPanel {...props()} />)

    const kind = screen.getByLabelText('Connection kind')
    expect(within(kind).getByRole('option', { name: 'postgres' })).toBeInTheDocument()
  })
})

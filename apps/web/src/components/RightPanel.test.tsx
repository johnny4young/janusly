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
    events: [],
    runNodes: [],
    selectedNode: null,
    selectedEdge: null,
    workflowNodes: [],
    workflowEdges: [],
    validationIssues: [],
    readinessResult: null,
    aiReviewIssues: [],
    tools: [],
    templates: [],
    solutionPacks: [],
    credentials: [],
    runs: [],
    workflows: [],
    usage: {},
    aiHealth: null,
    currentWorkflowName: 'Untitled',
    onOpenWorkflow: vi.fn(),
    onUseTemplate: vi.fn(),
    onInstallPlugin: vi.fn(),
    onInstallPack: vi.fn(),
    onSampleRunPack: vi.fn(),
    onInjectPackFailure: vi.fn(),
    onCreateCredential: vi.fn(),
    onOpenRun: vi.fn(),
    onRefreshPlatform: vi.fn(),
    onUpdateNodeConfig: vi.fn(),
    onUpdateNodeType: vi.fn(),
    onUpdateEdgeCondition: vi.fn(),
    onValidateWorkflow: vi.fn(async () => true),
    onInsertSnippet: vi.fn(),
    onApproveNode: vi.fn(),
    onSubmitHumanForm: vi.fn(),
    onReplayNode: vi.fn(),
    onReplayDeadLetter: vi.fn(),
    onResolveDeadLetter: vi.fn(),
    onGenerateWorkflow: vi.fn(async () => ({ mode: 'fallback', workflow: { dslVersion: '1.0', id: 'wf', name: 'Workflow', nodes: [], edges: [] } })),
    onExplainWorkflow: vi.fn(async () => ({ mode: 'fallback', explanation: '' })),
    onReviewWorkflow: vi.fn(async () => ({ mode: 'fallback', review: { status: 'pass', issues: [] } })),
    onOpenTab: vi.fn(),
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

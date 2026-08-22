import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { RightPanel, type RightPanelProps } from './RightPanel'

vi.mock('../api', () => ({
  api: vi.fn(),
}))
vi.mock('./RunsPanel', () => ({
  RunsPanel: ({ mode }: { mode?: string }) => (
    <div data-testid="runs-panel-mode">{mode ?? 'runs'}</div>
  ),
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
      aiActionRequest: null,
      onUpdateNodeConfig: vi.fn(),
      onUpdateNodeType: vi.fn(),
      onUpdateEdgeCondition: vi.fn(),
    onUpdateEdgeOnError: vi.fn(),
      onValidateWorkflow: vi.fn(async () => true),
      onInsertSnippet: vi.fn(),
      onGenerateWorkflow: vi.fn(async () => ({ mode: 'fallback' as const, workflow: { dslVersion: '1.0' as const, id: 'wf', name: 'Workflow', nodes: [], edges: [] } })),
      onExplainWorkflow: vi.fn(async () => ({ mode: 'fallback' as const, explanation: '' })),
      onReviewWorkflow: vi.fn(async () => ({ mode: 'fallback' as const, review: { status: 'pass' as const, issues: [] } })),
      onSuggestWorkflowImprovement: vi.fn(async () => ({ mode: 'fallback' as const, suggestions: [] })),
      onApplyWorkflowImprovement: vi.fn(async () => true),
    },
    catalog: {
      tools: [],
      templates: [],
      solutionPacks: [],
      credentials: [],
      workflows: [],
      onOpenWorkflow: vi.fn(),
      onCreateWorkflow: vi.fn(),
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
      deadLetters: [],
      workflows: [],
      usage: {},
      onOpenRun: vi.fn(),
      onRefreshPlatform: vi.fn(),
      onApproveNode: vi.fn(),
      onSubmitHumanForm: vi.fn(),
      onReplayNode: vi.fn(),
      onRedriveNode: vi.fn(),
      onSelectRecovery: vi.fn(),
      onClearActiveRun: vi.fn(),
      onReplayDeadLetter: vi.fn(),
      onResolveDeadLetter: vi.fn(),
    },
    navigation: { onOpenTab: vi.fn(), onOpenAiAction: vi.fn(), activeRecoveryCaseId: null },
    ...overrides,
  }
}

beforeEach(() => {
  vi.mocked(api).mockReset()
  vi.mocked(api).mockResolvedValue({ credentials: [] })
})

describe('<RightPanel /> credentials', () => {
  it('keeps creation focused and offers postgres for external DB tools', async () => {
    render(<RightPanel {...props()} />)

    const createActions = await screen.findAllByRole('button', { name: 'Add connection' })
    fireEvent.click(createActions[0]!)
    const kind = await screen.findByLabelText('Connection kind')
    expect(within(kind).getByRole('option', { name: 'postgres' })).toBeInTheDocument()
  })
})

describe('<RightPanel /> recovery task space', () => {
  it('mounts the action-focused recovery projection', async () => {
    const onOpenTab = vi.fn()
    render(<RightPanel {...props({
      tab: 'recover',
      permissions: ['runs.read', 'recovery.read'],
      navigation: { onOpenTab, onOpenAiAction: vi.fn(), activeRecoveryCaseId: null },
    })} />)

    expect(await screen.findByTestId('runs-panel-mode'))
      .toHaveTextContent('recovery')
    const sectionNav = screen.getByTestId('workspace-section-nav')
    expect(sectionNav).toHaveAttribute('data-destination', 'activity')
    expect(within(sectionNav).queryByRole('button')).not.toBeInTheDocument()
    expect(within(sectionNav).getByText('Activity')).toBeVisible()
  })

  it('filters contextual sections with the same effective permissions as global navigation', () => {
    render(<RightPanel {...props({
      tab: 'credentials',
      permissions: ['credentials.read'],
    })} />)

    const sectionNav = screen.getByTestId('workspace-section-nav')
    expect(within(sectionNav).getAllByRole('button')).toHaveLength(1)
    expect(within(sectionNav).getByRole('button', { name: /^Connections$/ }))
      .toHaveAttribute('aria-current', 'page')
  })
})

import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { RightPanel, type RightPanelProps } from './RightPanel'

vi.mock('../api', () => ({
  api: vi.fn(),
}))
vi.mock('./ReportsPanel', () => ({
  ReportsPanel: ({ permissions }: { permissions?: readonly string[] }) => (
    <div data-testid="reports-gates">{permissions?.join(' ')}</div>
  ),
}))
vi.mock('./AuthoringPanel', () => ({
  AuthoringPanel: () => <div data-testid="authoring-panel" />,
}))
vi.mock('./RunsPanel', () => ({
  RunsPanel: ({ mode, canReadRuns }: { mode?: string; canReadRuns?: boolean }) => (
    <div data-testid="runs-panel-mode" data-can-read-runs={String(canReadRuns)}>{mode ?? 'runs'}</div>
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
      onLoadAuthoringCapabilities: vi.fn(async () => ({
        schemaVersion: '1',
        version: 'test',
        builtinTools: [],
        mcpTools: [],
        triggers: [],
        credentials: [],
        subworkflows: [],
        primitives: [],
        warnings: [],
      })),
      onCompileWorkflowBrief: vi.fn(async () => { throw new Error('not used') }),
      onProposeWorkflow: vi.fn(async () => { throw new Error('not used') }),
      onApplyWorkflowProposal: vi.fn(async () => ({ status: 'cancelled' as const })),
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
      credentialsKnown: true,
      workflows: [],
      onOpenWorkflow: vi.fn(),
      onOpenWorkflowVersion: vi.fn(async () => true),
      onCreateWorkflow: vi.fn(),
      onUseTemplate: vi.fn(),
      onInstallPlugin: vi.fn(),
      onInstallPack: vi.fn(),
      onSampleRunPack: vi.fn(),
      onInjectPackFailure: vi.fn(),
      onCreateCredential: vi.fn(),
      onRevokeCredential: vi.fn(),
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
  // The cold lazy chunks can outlast a query's timeout on a loaded machine.
  beforeAll(() => Promise.all([import('./ConnectionsPanel'), import('./connection-dialogs')]))

  it('keeps creation focused and offers postgres for external DB tools', async () => {
    render(<RightPanel {...props()} />)

    const createActions = await screen.findAllByRole(
      'button',
      { name: 'Add connection' },
      { timeout: 5_000 },
    )
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
    expect(within(sectionNav).getByText('Activity')).toBeVisible()
    expect(within(sectionNav).getByRole('button', { name: 'Recover' }))
      .toHaveAttribute('aria-current', 'page')
    expect(within(sectionNav).getByRole('button', { name: 'Runs' }))
      .not.toHaveAttribute('aria-current')
  })

  it('passes the runs.read permission to Recover', async () => {
    render(<RightPanel {...props({ tab: 'recover', permissions: ['dlq.read', 'recovery.read'] })} />)

    expect(await screen.findByTestId('runs-panel-mode')).toHaveAttribute('data-can-read-runs', 'false')
  })

  it('mounts Reports with each widget gate and counts only open failures on Recover', async () => {
    const base = props()
    render(<RightPanel {...props({
      tab: 'reports',
      permissions: ['recovery.read', 'reports.read'],
      execution: {
        ...base.execution,
        deadLetters: [{ status: 'open' }, { status: 'open' }, { status: 'resolved' }] as typeof base.execution.deadLetters,
      },
    })} />)

    expect(await screen.findByTestId('reports-gates')).toHaveTextContent('recovery.read reports.read')
    const sectionNav = screen.getByTestId('workspace-section-nav')
    expect(within(sectionNav).getByRole('button', { name: 'Reports' })).toHaveAttribute('aria-current', 'page')
    expect(within(sectionNav).getByTestId('workspace-section-recover-count')).toHaveTextContent('2')
  })

  it('leaves section navigation to the top bar on the Build layout', async () => {
    render(<RightPanel {...props({ tab: 'inspector', permissions: ['workflows.read'] })} />)

    expect(await screen.findByTestId('authoring-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('workspace-section-nav')).toBeNull()
  })

  it.each([
    ['packs', 'with credentials.write', ['packs.read', 'credentials.write'], true],
    ['packs', 'without credentials.write', ['packs.read'], false],
    ['templates', 'with credentials.write', ['packs.read', 'credentials.write'], true],
    ['templates', 'without credentials.write', ['packs.read'], false],
  ] as const)('on %s, gates pack Connect by role (%s)', async (tab, _label, permissions, connects) => {
    const base = props({ tab, permissions: [...permissions] })
    render(<RightPanel {...base} catalog={{ ...base.catalog, solutionPacks: [{
      id: 'p',
      name: 'Pack',
      description: 'd',
      category: 'c',
      version: '1',
      assurance: { intentContract: false, recoveryContractVersion: '', qualificationFixtureCount: 0 },
      requiredCredentials: [{ name: 'c', kind: 'k', purpose: 'x' }],
      requiredOrgConfigs: [],
      nodeCount: 1,
      sampleCount: 0,
      failureCount: 0,
      samplePayloadIds: [],
      failureFixtureIds: [],
      failureFixtures: [],
    }] }} />)
    await screen.findByTestId('solution-pack-p')
    expect(screen.queryAllByTestId('pack-connect-p-c')).toHaveLength(connects ? 1 : 0)
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

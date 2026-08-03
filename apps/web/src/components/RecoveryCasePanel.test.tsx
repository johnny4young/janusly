import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { useWorkflowStore } from '../store'
import { RecoveryCasePanel } from './RecoveryCasePanel'

vi.mock('../api', () => ({ api: vi.fn() }))

const initialState = useWorkflowStore.getState()

function autonomy(level: 1 | 3 = 3) {
  return {
    level,
    source: level === 3 ? 'workflow_default' : 'failure_override',
    detectorIds: ['ai-mode'],
    unavailableReason: null,
    capabilities: {
      observe: true,
      recommend: true,
      validate: level >= 2,
      applyWithApproval: level >= 3,
      autonomousApply: false,
    },
    factors: [
      { capability: 'observe', requiredLevel: 0, enabled: true },
      { capability: 'recommend', requiredLevel: 1, enabled: true },
      { capability: 'validate', requiredLevel: 2, enabled: level >= 2 },
      {
        capability: 'apply_with_approval',
        requiredLevel: 3,
        enabled: level >= 3,
      },
      {
        capability: 'autonomous_apply',
        requiredLevel: 4,
        enabled: false,
      },
    ],
  }
}

function detail(
  state: 'contained' | 'verified_recovered' = 'contained',
  autonomyLevel: 1 | 3 = 3,
) {
  return {
    case: {
      id: 'case-1',
      orgId: 'org-1',
      runId: 'run-1',
      workflowId: 'workflow-1',
      workflowVersionId: 'version-1',
      source: 'semantic_violation',
      detectorId: 'ai-mode',
      sourceNodeId: 'answer',
      detectorKind: 'expression',
      action: 'quarantine',
      message: 'AI output is required',
      detailsJson: ['$.mode must equal "ai"'],
      state,
      createdBy: 'operator-1',
      createdAt: '2026-07-27T12:00:00.000Z',
      updatedAt: '2026-07-27T12:02:00.000Z',
      resolvedAt: state === 'verified_recovered'
        ? '2026-07-27T12:02:00.000Z'
        : null,
    },
    transitions: [
      {
        id: 'transition-1',
        orgId: 'org-1',
        caseId: 'case-1',
        fromState: 'detected',
        toState: 'contained',
        actorKind: 'system',
        actorId: null,
        evidenceJson: { detectorId: 'ai-mode' },
        reason: 'Downstream effects paused',
        occurredAt: '2026-07-27T12:00:01.000Z',
      },
    ],
    autonomy: autonomy(autonomyLevel),
  }
}

beforeEach(() => {
  vi.mocked(api).mockReset()
  useWorkflowStore.setState({
    ...initialState,
    toasts: [],
  }, true)
})

describe('<RecoveryCasePanel />', () => {
  it('renders bounded evidence and append-only transition history', async () => {
    vi.mocked(api).mockResolvedValue(detail())
    const onOpenRun = vi.fn()

    render(
      <RecoveryCasePanel
        caseId="case-1"
        canResolve
        onBack={vi.fn()}
        onOpenRun={onOpenRun}
        onResolved={vi.fn()}
      />,
    )

    expect(await screen.findByTestId('recovery-case-workspace-case-1'))
      .toHaveTextContent('AI output is required')
    expect(screen.getByText('$.mode must equal "ai"')).toBeVisible()
    expect(screen.getByText('Downstream effects paused')).toBeVisible()
    expect(screen.getByText(/System/)).toBeVisible()
    expect(
      screen.getByTestId('recovery-autonomy-profile-case-1'),
    ).toHaveTextContent('Level 3')
    expect(
      screen.getByTestId('recovery-autonomy-profile-case-1'),
    ).toHaveTextContent('Apply with approval')
    expect(api).toHaveBeenCalledWith('/v1/recovery/cases/case-1')

    fireEvent.click(screen.getByRole('button', { name: 'Open run' }))
    expect(onOpenRun).toHaveBeenCalledWith('run-1')
  })

  it('rejects the detail envelope when any transition receipt is malformed', async () => {
    const payload = detail()
    payload.transitions[0]!.actorKind = 'unknown'
    vi.mocked(api).mockResolvedValue(payload)

    render(
      <RecoveryCasePanel
        caseId="case-1"
        canResolve
        onBack={vi.fn()}
        onOpenRun={vi.fn()}
        onResolved={vi.fn()}
      />,
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The recovery case response was invalid.',
    )
    expect(screen.queryByTestId('recovery-case-workspace-case-1')).toBeNull()
  })

  it('validates and resolves a quarantined result from the case workspace', async () => {
    let resolved = false
    vi.mocked(api).mockImplementation(async (path, options) => {
      if (path === '/v1/recovery/cases/case-1') {
        return detail(resolved ? 'verified_recovered' : 'contained')
      }
      if (
        path === '/recovery/cases/case-1/resolve'
        && options?.method === 'POST'
      ) {
        resolved = true
        return {
          ok: true,
          runId: 'run-1',
          sourceNodeId: 'answer',
          decision: 'replace',
          resumed: true,
          resolvedCaseIds: ['case-1'],
        }
      }
      throw new Error(`Unexpected API call: ${path}`)
    })
    const onResolved = vi.fn().mockResolvedValue(undefined)

    render(
      <RecoveryCasePanel
        caseId="case-1"
        canResolve
        onBack={vi.fn()}
        onOpenRun={vi.fn()}
        onResolved={onResolved}
      />,
    )

    fireEvent.change(
      await screen.findByTestId('semantic-recovery-reason-case-1'),
      { target: { value: 'Reviewed against the authoritative record' } },
    )
    fireEvent.click(screen.getByTestId('semantic-recovery-replace-case-1'))

    await waitFor(() => {
      expect(api).toHaveBeenCalledWith(
        '/recovery/cases/case-1/resolve',
        {
          method: 'POST',
          body: JSON.stringify({
            decision: 'replace',
            reason: 'Reviewed against the authoritative record',
            output: { mode: 'ai' },
          }),
        },
      )
      expect(onResolved).toHaveBeenCalledTimes(1)
    })
    expect(await screen.findByText('Recovered')).toBeVisible()
    expect(screen.queryByTestId('semantic-recovery-replace-case-1')).toBeNull()
  })

  it('keeps viewers read-only while preserving the case evidence', async () => {
    vi.mocked(api).mockResolvedValue(detail())

    render(
      <RecoveryCasePanel
        caseId="case-1"
        canResolve={false}
        onBack={vi.fn()}
        onOpenRun={vi.fn()}
        onResolved={vi.fn()}
      />,
    )

    expect(await screen.findByText('AI output is required')).toBeVisible()
    expect(screen.getByText(/read-only access/i)).toBeVisible()
    expect(screen.queryByTestId('semantic-recovery-replace-case-1')).toBeNull()
  })

  it('blocks replacement below level 3 while retaining accepted-loss governance', async () => {
    vi.mocked(api).mockResolvedValue(detail('contained', 1))

    render(
      <RecoveryCasePanel
        caseId="case-1"
        canResolve
        onBack={vi.fn()}
        onOpenRun={vi.fn()}
        onResolved={vi.fn()}
      />,
    )

    const policy = await screen.findByTestId(
      'recovery-autonomy-profile-case-1',
    )
    expect(policy).toHaveTextContent('Level 1')
    expect(policy).toHaveTextContent('Apply with approval')
    expect(screen.getByText(/does not permit replacement/i)).toBeVisible()
    expect(
      screen.queryByTestId('semantic-recovery-output-case-1'),
    ).toBeNull()
    expect(
      screen.queryByTestId('semantic-recovery-replace-case-1'),
    ).toBeNull()
    expect(
      screen.getByTestId('semantic-recovery-accept-case-1'),
    ).toBeVisible()
  })
})

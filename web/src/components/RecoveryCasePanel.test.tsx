import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api, contractApi } from '../api'
import { useWorkflowStore } from '../store'
import { RecoveryCasePanel } from './RecoveryCasePanel'

vi.mock('../api', () => ({ api: vi.fn(), contractApi: vi.fn() }))

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

type TestState =
  | 'contained'
  | 'diagnosed'
  | 'candidates_ready'
  | 'awaiting_approval'
  | 'monitoring'
  | 'verified_recovered'

const revisions: Record<TestState, number> = {
  contained: 2,
  diagnosed: 3,
  candidates_ready: 4,
  awaiting_approval: 6,
  monitoring: 8,
  verified_recovered: 9,
}

function artifact(
  id: string,
  kind: 'diagnosis' | 'candidate' | 'validation' | 'publication' | 'verification',
  payload: unknown,
  hashChar: string,
) {
  return {
    id,
    caseId: 'case-1',
    kind,
    payload,
    sha256: hashChar.repeat(64),
    actorKind: 'user',
    actorId: 'operator-1',
    createdAt: '2026-07-27T12:01:00.000Z',
  }
}

const diagnosis = artifact('diagnosis-1', 'diagnosis', {
  mode: 'deterministic_fallback',
  summary: 'AI output did not satisfy the semantic contract',
  hypotheses: [{
    id: 'contract-violation',
    cause: 'The mode field is not ai.',
    confidence: 0.82,
    evidence: ['The deterministic detector rejected mode=manual.'],
    counterEvidence: ['The retained evidence does not include the upstream model response.'],
  }],
}, 'a')

const replacementCandidate = artifact('candidate-replace', 'candidate', {
  kind: 'replace_output',
  decision: 'replace',
  output: { mode: 'ai' },
  reason: 'Reviewed against the authoritative record',
  risk: 'medium',
  expectedResult: 'The semantic detector passes',
  requiredPermissions: ['recovery.write'],
}, 'b')

const repairCandidate = artifact('candidate-repair', 'candidate', {
  kind: 'repair_workflow',
  decision: 'manual_follow_up',
  target: {
    workflowId: 'workflow-1',
    workflowVersionId: 'version-1',
  },
  reason: 'Create and qualify a successor workflow version',
  risk: 'medium',
  expectedResult: 'A qualified successor addresses future executions',
  requiredPermissions: ['recovery.write', 'workflows.write'],
}, 'c')

const lossCandidate = artifact('candidate-loss', 'candidate', {
  kind: 'accept_loss',
  decision: 'accept_loss',
  reason: 'Explicitly accept this business outcome loss',
  risk: 'high',
  expectedResult: 'The case closes without changing output',
  requiredPermissions: ['recovery.write'],
}, 'd')

const validation = artifact('validation-1', 'validation', {
  candidateArtifactId: replacementCandidate.id,
  candidateSha256: replacementCandidate.sha256,
  caseRevision: 4,
  passed: true,
  summary: 'Replacement passed every deterministic detector',
}, 'e')

const publication = artifact('publication-1', 'publication', {
  candidateArtifactId: replacementCandidate.id,
  validationArtifactId: validation.id,
}, 'f')

const verification = artifact('verification-1', 'verification', {
  resultState: 'verified_recovered',
  deterministicValidationPassed: true,
}, '0')

function detail(
  state: TestState = 'contained',
  autonomyLevel: 1 | 3 = 3,
  artifacts: ReturnType<typeof artifact>[] = [],
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
      revision: revisions[state],
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
        evidenceJson: [{ kind: 'semantic_detector', id: 'ai-mode' }],
        reason: 'Downstream effects paused',
        occurredAt: '2026-07-27T12:00:01.000Z',
      },
    ],
    artifacts,
    autonomy: autonomy(autonomyLevel),
  }
}

beforeEach(() => {
  vi.mocked(api).mockReset()
  vi.mocked(contractApi).mockReset()
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

  it('runs diagnose → candidates → validate → approve → apply as distinct governed operations', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce(detail('contained'))
      .mockResolvedValueOnce(detail('diagnosed', 3, [diagnosis]))
      .mockResolvedValueOnce(detail('candidates_ready', 3, [
        diagnosis,
        repairCandidate,
        lossCandidate,
        replacementCandidate,
      ]))
      .mockResolvedValueOnce(detail('awaiting_approval', 3, [
        diagnosis,
        repairCandidate,
        lossCandidate,
        replacementCandidate,
        validation,
      ]))
      .mockResolvedValueOnce(detail('awaiting_approval', 3, [
        diagnosis,
        repairCandidate,
        lossCandidate,
        replacementCandidate,
        validation,
      ]))
      .mockResolvedValueOnce(detail('monitoring', 3, [
        diagnosis,
        repairCandidate,
        lossCandidate,
        replacementCandidate,
        validation,
        publication,
      ]))
      .mockResolvedValueOnce(detail('verified_recovered', 3, [
        diagnosis,
        repairCandidate,
        lossCandidate,
        replacementCandidate,
        validation,
        publication,
        verification,
      ]))
    vi.mocked(contractApi)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        runId: 'run-1',
        sourceNodeId: 'answer',
        decision: 'replace',
        resumed: true,
        resolvedCaseIds: ['case-1'],
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

    fireEvent.click(await screen.findByTestId('semantic-recovery-diagnose-case-1'))
    await waitFor(() => expect(contractApi).toHaveBeenNthCalledWith(
      1,
      'POST /recovery/cases/{caseId}/diagnose',
      '/recovery/cases/case-1/diagnose',
      { expectedRevision: 2 },
    ))
    expect(await screen.findByTestId('recovery-diagnosis-case-1'))
      .toHaveTextContent('Deterministic')
    expect(screen.getByText('The deterministic detector rejected mode=manual.'))
      .toBeVisible()
    expect(screen.getByText('The retained evidence does not include the upstream model response.'))
      .toBeVisible()

    fireEvent.change(
      await screen.findByTestId('semantic-recovery-reason-case-1'),
      { target: { value: 'Reviewed against the authoritative record' } },
    )
    fireEvent.click(screen.getByTestId('semantic-recovery-propose-case-1'))
    await waitFor(() => expect(contractApi).toHaveBeenNthCalledWith(
      2,
      'POST /recovery/cases/{caseId}/candidates',
      '/recovery/cases/case-1/candidates',
      {
        expectedRevision: 3,
        manualReplacement: {
          output: { mode: 'ai' },
          reason: 'Reviewed against the authoritative record',
        },
      },
    ))

    expect(screen.getByRole('radio', { name: /Replace output/ })).toBeChecked()

    fireEvent.click(await screen.findByTestId('semantic-recovery-validate-case-1'))
    await waitFor(() => expect(contractApi).toHaveBeenNthCalledWith(
      3,
      'POST /recovery/cases/{caseId}/validate',
      '/recovery/cases/case-1/validate',
      { expectedRevision: 4, candidateArtifactId: replacementCandidate.id },
    ))

    fireEvent.click(await screen.findByTestId('semantic-recovery-approve-case-1'))
    await waitFor(() => expect(contractApi).toHaveBeenNthCalledWith(
      4,
      'POST /recovery/cases/{caseId}/approve',
      '/recovery/cases/case-1/approve',
      {
        expectedRevision: 6,
        candidateArtifactId: replacementCandidate.id,
        validationArtifactId: validation.id,
      },
    ))

    fireEvent.click(await screen.findByTestId('semantic-recovery-apply-case-1'))
    await waitFor(() => {
      expect(contractApi).toHaveBeenNthCalledWith(
        5,
        'POST /recovery/cases/{caseId}/apply',
        '/recovery/cases/case-1/apply',
        {
          expectedRevision: 6,
          candidateArtifactId: replacementCandidate.id,
          validationArtifactId: validation.id,
        },
      )
      expect(onResolved).toHaveBeenCalledTimes(1)
    })
    expect((await screen.findByText('Monitoring')).closest('[data-tone]')).toHaveAttribute(
      'data-tone',
      'info',
    )
    expect(await screen.findByText('Recovered', {}, { timeout: 2_500 })).toBeVisible()
    expect(screen.queryByTestId('semantic-recovery-apply-case-1')).toBeNull()
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
    expect(screen.getAllByText(/read-only access/i)).toHaveLength(2)
    expect(screen.queryByTestId('semantic-recovery-diagnose-case-1')).toBeNull()
  })

  it('blocks replacement below level 3 while retaining accepted-loss governance', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce(detail('contained', 1))
      .mockResolvedValueOnce(detail('diagnosed', 1, [diagnosis]))
    vi.mocked(contractApi).mockResolvedValue({})

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

    fireEvent.click(screen.getByTestId('semantic-recovery-diagnose-case-1'))
    expect(
      await screen.findByTestId('semantic-recovery-accept-case-1'),
    ).toBeVisible()
    expect(
      screen.queryByTestId('semantic-recovery-output-case-1'),
    ).toBeNull()
    expect(
      screen.queryByTestId('semantic-recovery-propose-case-1'),
    ).toBeNull()
  })
})

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  | 'accepted_loss'

const revisions: Record<TestState, number> = {
  contained: 2,
  diagnosed: 3,
  candidates_ready: 4,
  awaiting_approval: 6,
  monitoring: 8,
  verified_recovered: 9,
  accepted_loss: 7,
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
  evidence: [{ kind: 'run', id: 'run-1' }],
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
  evidence: [{ kind: 'case_artifact', id: 'diagnosis-1', sha256: 'a'.repeat(64) }],
  expectedResult: 'A qualified successor addresses future executions',
  requiredPermissions: ['recovery.write', 'workflows.write'],
}, 'c')

const lossCandidate = artifact('candidate-loss', 'candidate', {
  kind: 'accept_loss',
  decision: 'accept_loss',
  reason: 'Explicitly accept this business outcome loss',
  risk: 'high',
  evidence: [{ kind: 'operator_decision', id: 'operator-1' }],
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

const lossValidation = artifact('validation-loss', 'validation', {
  candidateArtifactId: lossCandidate.id,
  candidateSha256: lossCandidate.sha256,
  caseRevision: 4,
  passed: true,
  summary: 'Loss acknowledgement is structurally valid and still requires human approval',
}, '1')

const publication = artifact('publication-1', 'publication', {
  candidateArtifactId: replacementCandidate.id,
  validationArtifactId: validation.id,
}, 'f')

const verification = artifact('verification-1', 'verification', {
  resultState: 'verified_recovered',
  deterministicValidationPassed: true,
}, '0')

const activeReplacementApproval = {
  candidateArtifactId: replacementCandidate.id,
  validationArtifactId: validation.id,
  caseRevision: revisions.awaiting_approval,
  expiresAt: '2099-07-27T12:30:00.000Z',
}

const activeLossApproval = {
  candidateArtifactId: lossCandidate.id,
  validationArtifactId: lossValidation.id,
  caseRevision: revisions.awaiting_approval,
  expiresAt: '2099-07-27T12:30:00.000Z',
}

function detail(
  state: TestState = 'contained',
  autonomyLevel: 1 | 3 = 3,
  artifacts: ReturnType<typeof artifact>[] = [],
  activeApproval: typeof activeReplacementApproval | null = null,
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
      resolvedAt: state === 'verified_recovered' || state === 'accepted_loss'
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
    activeApproval,
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

  it.each([
    ['case timestamp', (payload: ReturnType<typeof detail>) => {
      payload.case.createdAt = 'not-a-date'
    }],
    ['transition timestamp', (payload: ReturnType<typeof detail>) => {
      payload.transitions[0]!.occurredAt = 'not-a-date'
    }],
    ['artifact timestamp', (payload: ReturnType<typeof detail>) => {
      payload.artifacts = [{ ...diagnosis, createdAt: 'not-a-date' }]
    }],
    ['over-bounded transition id', (payload: ReturnType<typeof detail>) => {
      payload.transitions[0]!.id = 'x'.repeat(257)
    }],
  ] as const)('rejects an unsafe %s before date formatting or rendering', async (_label, mutate) => {
    const payload = detail()
    mutate(payload)
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

  it('rejects over-bounded recovery history before rendering it', async () => {
    const payload = detail()
    payload.transitions = Array.from({ length: 101 }, (_, index) => ({
      ...payload.transitions[0]!,
      id: `transition-${index}`,
    }))
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

  it('rejects malformed governed candidate and validation payloads', async () => {
    const malformedCandidate = artifact('candidate-malformed', 'candidate', {
      kind: 'accept_loss',
      decision: 'replace',
      output: { mode: 'ai' },
      reason: 'Mismatched immutable authority',
      risk: 'high',
      evidence: [{ kind: 'run', id: 'run-1' }],
      expectedResult: 'Must not render',
      requiredPermissions: ['recovery.write'],
    }, '9')
    vi.mocked(api).mockResolvedValue(detail('candidates_ready', 3, [malformedCandidate]))

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
    expect(screen.queryByText('Must not render')).toBeNull()
    expect(screen.queryByTestId('recovery-case-workspace-case-1')).toBeNull()
  })

  it('rejects hostile candidate enum objects without invoking coercion hooks', async () => {
    const malformedCandidate = artifact('candidate-hostile-enum', 'candidate', {
      kind: { toString: 1, valueOf: 1 },
      decision: 'replace',
      output: { mode: 'ai' },
      reason: 'Must fail closed',
      risk: 'medium',
      evidence: [{ kind: 'run', id: 'run-1' }],
      expectedResult: 'Must not render',
      requiredPermissions: ['recovery.write'],
    }, '5')
    vi.mocked(api).mockResolvedValue(detail('candidates_ready', 3, [malformedCandidate]))

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
    expect(screen.queryByText('Must not render')).toBeNull()
  })

  it.each([
    ['missing evidence', undefined],
    ['an unknown evidence kind', [{ kind: 'secret', id: 'credential-1' }]],
    ['an evidence identifier above the UTF-8 byte limit', [{
      kind: 'run',
      id: 'é'.repeat(251),
    }]],
  ])('rejects a governed candidate with %s', async (_label, evidence) => {
    const candidatePayload: Record<string, unknown> = {
      kind: 'replace_output',
      decision: 'replace',
      output: { mode: 'ai' },
      reason: 'Must not establish recovery authority',
      risk: 'medium',
      expectedResult: 'Must not render',
      requiredPermissions: ['recovery.write'],
    }
    if (evidence !== undefined) candidatePayload.evidence = evidence
    const malformedCandidate = artifact(
      'candidate-evidence-malformed',
      'candidate',
      candidatePayload,
      '7',
    )
    vi.mocked(api).mockResolvedValue(detail('candidates_ready', 3, [malformedCandidate]))

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
    expect(screen.queryByText('Must not render')).toBeNull()
  })

  it('rejects a validation artifact whose hash does not bind its candidate', async () => {
    const mismatchedValidation = artifact('validation-mismatch', 'validation', {
      candidateArtifactId: replacementCandidate.id,
      candidateSha256: '7'.repeat(64),
      caseRevision: 4,
      passed: true,
      summary: 'Must not create approval authority',
    }, '8')
    vi.mocked(api).mockResolvedValue(detail('awaiting_approval', 3, [
      replacementCandidate,
      mismatchedValidation,
    ]))

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
    expect(screen.queryByText('Must not create approval authority')).toBeNull()
  })

  it.each([
    ['an unknown field', {
      candidateArtifactId: replacementCandidate.id,
      candidateSha256: replacementCandidate.sha256,
      caseRevision: 4,
      passed: true,
      summary: 'Must not create approval authority',
      debug: true,
    }],
    ['a missing passed field', {
      candidateArtifactId: replacementCandidate.id,
      candidateSha256: replacementCandidate.sha256,
      caseRevision: 4,
      summary: 'Must not create approval authority',
    }],
  ])('rejects validation authority with %s', async (_label, payload) => {
    const malformedValidation = artifact(
      'validation-contract-drift',
      'validation',
      payload,
      '6',
    )
    vi.mocked(api).mockResolvedValue(detail('awaiting_approval', 3, [
      replacementCandidate,
      malformedValidation,
    ]))

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
    expect(screen.queryByText('Must not create approval authority')).toBeNull()
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
      ], activeReplacementApproval))
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

    const replacementRadio = screen.getByRole('radio', { name: /Replace output/ })
    expect(replacementRadio).toBeChecked()
    expect(replacementRadio).toHaveAccessibleName('Replace output')
    expect(replacementRadio).toHaveAttribute(
      'aria-describedby',
      `recovery-candidate-facts-${replacementCandidate.id}`,
    )
    const replacementCard = replacementRadio.closest('label')
    expect(replacementCard).not.toBeNull()
    expect(within(replacementCard!).getByText('The semantic detector passes')).toBeVisible()
    expect(within(replacementCard!).getByText('run: run-1')).toBeVisible()
    expect(within(replacementCard!).getByText('recovery.write')).toBeVisible()

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

  it('hands manual workflow repair to the exact source and a non-submitted authoring prefill', async () => {
    vi.mocked(api).mockResolvedValue(detail('candidates_ready', 3, [
      diagnosis,
      repairCandidate,
    ]))
    const onOpenWorkflowVersion = vi.fn(async () => true)
    const onOpenAiAuthoring = vi.fn()

    render(
      <RecoveryCasePanel
        caseId="case-1"
        canResolve
        canInspectWorkflow
        canAuthorWorkflow
        onBack={vi.fn()}
        onOpenRun={vi.fn()}
        onOpenWorkflowVersion={onOpenWorkflowVersion}
        onOpenAiAuthoring={onOpenAiAuthoring}
        onResolved={vi.fn()}
      />,
    )

    expect(await screen.findByRole('radio', { name: 'Repair workflow' })).toBeChecked()
    expect(screen.getByRole('button', { name: 'Suggest improvement' })).toBeVisible()

    fireEvent.click(screen.getByTestId('semantic-recovery-inspect-source-case-1'))
    await waitFor(() => expect(onOpenWorkflowVersion).toHaveBeenCalledWith(
      'workflow-1',
      'version-1',
      'inspector',
    ))
    expect(onOpenAiAuthoring).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('semantic-recovery-author-successor-case-1'))
    await waitFor(() => expect(onOpenWorkflowVersion).toHaveBeenLastCalledWith(
      'workflow-1',
      'version-1',
      'ai-studio',
    ))
    expect(onOpenAiAuthoring).toHaveBeenCalledOnce()
    expect(onOpenAiAuthoring.mock.calls[0]?.[0]).toContain('workflow-1@version-1')
    expect(onOpenAiAuthoring.mock.calls[0]?.[0]).toContain('never apply, save, run, approve, or recover')
    expect(contractApi).not.toHaveBeenCalled()
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

  it('reports an accepted loss honestly instead of showing replacement copy', async () => {
    const awaitingLoss = detail('awaiting_approval', 1, [
      diagnosis,
      lossCandidate,
      lossValidation,
    ])
    vi.mocked(api)
      .mockResolvedValueOnce(awaitingLoss)
      .mockResolvedValueOnce(detail('awaiting_approval', 1, [
        diagnosis,
        lossCandidate,
        lossValidation,
      ], activeLossApproval))
      .mockResolvedValueOnce(detail('accepted_loss', 1, [
        diagnosis,
        lossCandidate,
        lossValidation,
      ]))
    vi.mocked(contractApi)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        runId: 'run-1',
        sourceNodeId: 'answer',
        decision: 'accept_loss',
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

    expect(await screen.findByRole('radio', { name: /Accept loss/ })).toBeChecked()
    fireEvent.click(await screen.findByTestId('semantic-recovery-approve-case-1'))
    fireEvent.click(await screen.findByTestId('semantic-recovery-apply-case-1'))

    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1))
    expect(useWorkflowStore.getState().toasts.at(-1)).toMatchObject({
      message: "Recorded from the operator's accepted-loss decision.",
      tone: 'success',
    })
  })

  it('restores the exact active approval after a browser refresh', async () => {
    vi.mocked(api).mockResolvedValue(detail('awaiting_approval', 3, [
      lossCandidate,
      replacementCandidate,
      validation,
    ], activeReplacementApproval))

    render(
      <RecoveryCasePanel
        caseId="case-1"
        canResolve
        onBack={vi.fn()}
        onOpenRun={vi.fn()}
        onResolved={vi.fn()}
      />,
    )

    expect(await screen.findByRole('radio', { name: /Replace output/ })).toBeChecked()
    expect(screen.getByTestId('semantic-recovery-apply-case-1')).toBeVisible()
    expect(screen.queryByTestId('semantic-recovery-approve-case-1')).toBeNull()
  })

  it('fails closed when the active approval does not bind the current validation', async () => {
    vi.mocked(api).mockResolvedValue(detail('awaiting_approval', 3, [
      replacementCandidate,
      validation,
    ], {
      ...activeReplacementApproval,
      validationArtifactId: 'validation-swapped',
    }))

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
    expect(screen.queryByTestId('semantic-recovery-apply-case-1')).toBeNull()
  })

  it('treats an approval that expired in transit as inactive', async () => {
    vi.mocked(api).mockResolvedValue(detail('awaiting_approval', 3, [
      replacementCandidate,
      validation,
    ], {
      ...activeReplacementApproval,
      expiresAt: '2000-01-01T00:00:00.000Z',
    }))

    render(
      <RecoveryCasePanel
        caseId="case-1"
        canResolve
        onBack={vi.fn()}
        onOpenRun={vi.fn()}
        onResolved={vi.fn()}
      />,
    )

    expect(await screen.findByTestId('semantic-recovery-approve-case-1')).toBeVisible()
    expect(screen.queryByTestId('semantic-recovery-apply-case-1')).toBeNull()
  })
})

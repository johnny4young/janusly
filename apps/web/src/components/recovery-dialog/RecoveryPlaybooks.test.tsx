import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../../api'
import type { DeadLetter } from '../DeadLettersPanel'
import { RecoveryDialog } from '../RecoveryDialog'
import { PlaybookPromotionCard } from './PlaybookPromotionCard'
import type { RecoveryPlaybookSummary } from './types'

vi.mock('../../api', () => ({ api: vi.fn() }))

const playbook: RecoveryPlaybookSummary = {
  id: 'pb-1', workflowId: 'wf-1', signature: 'Network timeout on http node', version: 2,
  status: 'active', title: 'Recover billing', instructionsMarkdown: 'Use the bounded timeout change.',
  approachLabel: 'raise_timeout', successfulUses: 3, regressions: 0,
  lastValidatedAt: '2026-07-11T10:00:00.000Z', activatedAt: '2026-07-11T10:01:00.000Z',
  retiredAt: null, createdAt: '2026-07-11T10:00:00.000Z', updatedAt: '2026-07-11T10:01:00.000Z',
}

const failedWorkflow = {
  id: 'wf-1', name: 'Billing', dslVersion: '1.0',
  nodes: [{ id: 'fetch', type: 'http', config: { url: 'https://example.com', timeoutMs: 1000 } }],
  edges: [],
}
const recoveredWorkflow = {
  ...failedWorkflow,
  nodes: [{ id: 'fetch', type: 'http', config: { url: 'https://example.com', timeoutMs: 5000 } }],
}
const dlq: DeadLetter = {
  id: 'dlq-1', runId: 'run-12345678', nodeId: 'fetch', attempt: 2, status: 'open',
  workflowJson: failedWorkflow as never, nodeJson: failedWorkflow.nodes[0] as never,
  errorJson: { message: 'request timed out' },
}

beforeEach(() => {
  vi.mocked(api).mockReset()
})

describe('Recovery Playbook reuse', () => {
  it('offers an exact match explicitly and still routes it through sandbox validation', async () => {
    vi.mocked(api).mockImplementation(async (path: string, options?: RequestInit) => {
      if (path.startsWith('/recovery/playbooks/match')) return { playbook }
      if (path === '/recovery/playbooks/pb-1/use') {
        return {
          suggestion: {
            mode: 'playbook',
            suggestedWorkflow: recoveredWorkflow,
            rationale: playbook.instructionsMarkdown,
            suggestions: [{
              workflow: recoveredWorkflow,
              rationale: playbook.instructionsMarkdown,
              approachLabel: 'raise_timeout', confidence: 100, calibratedConfidence: 100,
              safety: { writeSide: false, approvalRequired: false, approvalPresent: true },
            }],
            evidence: [{ kind: 'recovery_playbook', sourceRef: 'pb-1', snippet: 'Version 2; 3 successful uses.' }],
            recoveryPassport: { failureSignature: playbook.signature, priorSameSignatureOutcome: null },
            playbook,
          },
        }
      }
      if (path === '/dlq/validate-fix') return { runId: 'validation-1' }
      return { ok: true, options }
    })

    render(<RecoveryDialog dlq={dlq} onClose={vi.fn()} />)
    const card = await screen.findByTestId('recovery-playbook-match')
    expect(card).toHaveTextContent('Recover billing')
    expect(card).toHaveTextContent('never runs automatically')
    fireEvent.click(screen.getByRole('button', { name: 'Retire', exact: true }))
    expect(screen.getByTestId('recovery-playbook-retire-confirm')).toHaveTextContent('Retire this playbook?')
    expect(vi.mocked(api).mock.calls.some((call) => call[0] === '/recovery/playbooks/pb-1/retire')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Keep active', exact: true }))
    fireEvent.click(screen.getByRole('button', { name: /Use and revalidate/i }))

    const source = await screen.findByTestId('recovery-playbook-revalidation')
    expect(source).toHaveTextContent('Recover billing v2')
    expect(screen.queryByRole('button', { name: /Apply validated fix/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Validate in sandbox/i }))

    await waitFor(() => {
      const request = vi.mocked(api).mock.calls.find((call) => call[0] === '/dlq/validate-fix')
      expect(request).toBeTruthy()
      if (!request) throw new Error('validation request not captured')
      const body = JSON.parse((request[1] as RequestInit).body as string)
      expect(body).toMatchObject({ deadLetterId: 'dlq-1', recoveryPlaybookId: 'pb-1', suggestedWorkflow: recoveredWorkflow })
    })
  })

  it('explains that a regressing playbook was retired after the failed sandbox', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path.startsWith('/recovery/playbooks/match')) return { playbook }
      if (path === '/recovery/playbooks/pb-1/use') {
        return {
          suggestion: {
            mode: 'playbook',
            suggestedWorkflow: recoveredWorkflow,
            rationale: playbook.instructionsMarkdown,
            suggestions: [{
              workflow: recoveredWorkflow,
              rationale: playbook.instructionsMarkdown,
              approachLabel: 'raise_timeout', confidence: 100, calibratedConfidence: 100,
              safety: { writeSide: false, approvalRequired: false, approvalPresent: true },
            }],
            evidence: [{ kind: 'recovery_playbook', sourceRef: 'pb-1', snippet: 'Version 2; 3 successful uses.' }],
            recoveryPassport: { failureSignature: playbook.signature, priorSameSignatureOutcome: null },
            playbook,
          },
        }
      }
      if (path === '/dlq/validate-fix') return { runId: 'validation-regressed' }
      if (path.startsWith('/run?runId=validation-regressed')) {
        return {
          run: { id: 'validation-regressed', status: 'failed' },
          nodes: [{ nodeId: 'fetch', status: 'failed', errorJson: { message: 'timeout still exceeded' } }],
        }
      }
      if (path === '/recovery/playbooks/pb-1/outcome') {
        return { playbook: { ...playbook, status: 'retired', regressions: 1 } }
      }
      return { ok: true }
    })

    render(<RecoveryDialog dlq={dlq} onClose={vi.fn()} />)
    await screen.findByTestId('recovery-playbook-match')
    fireEvent.click(screen.getByRole('button', { name: /Use and revalidate/i }))
    await screen.findByTestId('recovery-playbook-revalidation')
    fireEvent.click(screen.getByRole('button', { name: /Validate in sandbox/i }))

    const regression = await screen.findByTestId('recovery-playbook-regression', {}, { timeout: 4000 })
    expect(regression).toHaveTextContent('Playbook retired after regression')
    expect(regression).toHaveTextContent('retired the playbook before it could be used again')
    expect(screen.getByText('timeout still exceeded')).toBeInTheDocument()
  })
})

describe('Recovery Playbook manual promotion', () => {
  it('creates a draft first and activates it only after a separate click', async () => {
    vi.mocked(api)
      .mockResolvedValueOnce({ playbook: { ...playbook, status: 'draft', successfulUses: 0 }, created: true })
      .mockResolvedValueOnce({ playbook: { ...playbook, status: 'active', successfulUses: 0 } })

    render(<PlaybookPromotionCard source={{
      deadLetterId: 'dlq-1', validationRunId: 'validation-1', sourceWorkflowVersionId: 'wv-2',
      defaultTitle: 'Recover billing', defaultInstructions: 'Use the bounded timeout change.',
    }} />)

    fireEvent.click(screen.getByRole('button', { name: /Create playbook/i }))
    expect(screen.getByTestId('recovery-playbook-form')).toBeInTheDocument()
    expect(screen.getByLabelText('Playbook title')).toHaveValue('Recover billing')
    fireEvent.click(screen.getByRole('button', { name: /Save draft/i }))

    const draft = await screen.findByTestId('recovery-playbook-draft')
    expect(draft).toHaveTextContent('Draft ready')
    expect(vi.mocked(api)).toHaveBeenNthCalledWith(1, '/recovery/playbooks', expect.any(Object))
    expect(screen.queryByTestId('recovery-playbook-active')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Activate playbook/i }))
    expect(await screen.findByTestId('recovery-playbook-active')).toHaveTextContent('Recovery playbook active')
    expect(vi.mocked(api)).toHaveBeenNthCalledWith(2, '/recovery/playbooks/pb-1/activate', expect.any(Object))
  })
})

import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { initI18n } from '../../i18n'
import type { DeadLetter } from '../DeadLettersPanel'
import { RecoveryPassportCard } from './RecoveryPassportCard'

const dlq: DeadLetter = {
  id: 'dlq-browser',
  runId: 'run-browser',
  nodeId: 'fetch',
  attempt: 2,
  status: 'open',
  workflowJson: { dslVersion: '1.0', nodes: [], edges: [] },
  nodeJson: { id: 'fetch', type: 'http', config: {} },
  errorJson: { message: 'ECONNRESET' },
  recovery: {
    id: 'ri-browser', owner: null, severity: 'p2', status: 'open',
    slaTargetAt: '2026-07-12T00:00:00.000Z', resolutionReason: null, comments: [],
    occurrenceCount: 3,
  },
}

describe('<RecoveryPassportCard /> (browser smoke)', () => {
  afterEach(() => initI18n('en'))

  it('renders a visible safe verdict after an evidenced read-side sandbox pass', async () => {
    render(<RecoveryPassportCard
      dlq={dlq}
      suggestion={{
        mode: 'ai',
        suggestedWorkflow: dlq.workflowJson as never,
        rationale: 'Added retry',
        suggestions: [],
        evidence: [{ kind: 'signature_rule', sourceRef: 'network_timeout', snippet: 'Matched timeout' }],
      }}
      selected={{
        workflow: dlq.workflowJson as never,
        rationale: 'Added retry',
        approachLabel: 'add_retry',
        confidence: 100,
        safety: { writeSide: false, approvalRequired: false, approvalPresent: true },
      }}
      actionable
      sandboxStatus="passed"
      failureSignature="Network timeout on http node"
    />)

    const passport = await screen.findByTestId('recovery-confidence-passport')
    expect(passport).toHaveAttribute('data-verdict', 'safe_to_apply')
    expect(passport).toHaveTextContent('Safe to apply')
    expect(passport).toHaveTextContent('3 occurrences')
    expect(passport.getBoundingClientRect().height).toBeGreaterThan(0)
    expect(getComputedStyle(passport).display).not.toBe('none')
  })

  it('renders the blocked fallback verdict in Spanish', async () => {
    initI18n('es')
    render(<RecoveryPassportCard
      dlq={dlq}
      suggestion={{
        mode: 'fallback',
        suggestedWorkflow: dlq.workflowJson as never,
        rationale: 'No model',
        suggestions: [],
      }}
      selected={{
        workflow: dlq.workflowJson as never,
        rationale: 'No model',
        approachLabel: 'other',
        confidence: 0,
      }}
      actionable={false}
      sandboxStatus="not_run"
      failureSignature="Network timeout on http node"
    />)

    const passport = await screen.findByTestId('recovery-confidence-passport')
    expect(passport).toHaveAttribute('data-verdict', 'unsafe')
    expect(passport).toHaveTextContent('No es seguro aplicar')
    expect(passport).toHaveTextContent('No hay un parche aplicable')
  })
})

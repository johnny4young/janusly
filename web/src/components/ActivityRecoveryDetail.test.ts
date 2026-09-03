import { describe, expect, it } from 'vitest'

import type { DeadLetter } from './DeadLettersPanel'
import { mergeActivityRecoveryDetail } from './ActivityRecoveryDetail'

describe('mergeActivityRecoveryDetail', () => {
  it('preserves bounded workflow and node labels when the detail payload omits them', () => {
    const summary: DeadLetter = {
      id: 'dead-letter-1',
      runId: 'run-1',
      nodeId: 'load_customer',
      nodeType: 'transform',
      workflowName: 'Customer sync',
      attempt: 1,
      status: 'open',
      createdAt: '2026-07-28T12:00:00.000Z',
      errorJson: { message: 'summary' },
    }
    const detail: DeadLetter = {
      id: 'dead-letter-1',
      runId: 'run-1',
      nodeId: 'load_customer',
      attempt: 1,
      status: 'open',
      workflowJson: { name: 'Customer sync' },
      nodeJson: { type: 'transform' },
      errorJson: { message: 'detail' },
    }

    expect(mergeActivityRecoveryDetail(summary, detail)).toMatchObject({
      workflowName: 'Customer sync',
      nodeType: 'transform',
      createdAt: '2026-07-28T12:00:00.000Z',
      errorJson: { message: 'detail' },
    })
  })

  it('derives bounded labels from an off-list immutable snapshot', () => {
    const detail: DeadLetter = {
      id: 'dead-letter-drill',
      runId: 'run-drill',
      nodeId: 'page_oncall',
      attempt: 1,
      status: 'open',
      workflowJson: { name: 'Incident triage', nodes: [] },
      nodeJson: { id: 'page_oncall', type: 'tool' },
      errorJson: { code: 'worker_stalled' },
    }

    expect(mergeActivityRecoveryDetail(detail, detail)).toMatchObject({
      workflowName: 'Incident triage',
      nodeType: 'tool',
    })
  })

  it('keeps detail status until the bounded summary advances after the detail fetch', () => {
    const summary: DeadLetter = {
      id: 'dead-letter-1',
      runId: 'run-1',
      nodeId: 'load_customer',
      attempt: 1,
      status: 'open',
      errorJson: { message: 'summary' },
    }
    const detail: DeadLetter = {
      ...summary,
      status: 'resolved',
      errorJson: { message: 'detail' },
    }

    expect(mergeActivityRecoveryDetail(summary, detail, 'open').status).toBe('resolved')
    expect(mergeActivityRecoveryDetail(
      { ...summary, status: 'replayed' },
      detail,
      'open',
    ).status).toBe('replayed')
  })
})

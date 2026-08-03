import { describe, expect, it } from 'vitest'

import {
  buildActivityFeed,
  countActivityFeed,
  filterActivityFeed,
} from './activity-feed'
import type { RunSummary, SavedWorkflow } from './types'
import type { DeadLetter } from './components/DeadLettersPanel'

const workflows: SavedWorkflow[] = [{
  id: 'workflow-billing',
  orgId: 'org-1',
  name: 'Billing recovery',
}]

function run(id: string, status: string, createdAt: string): RunSummary {
  return {
    id,
    workflowId: 'workflow-billing',
    status,
    createdAt,
  }
}

function recovery(
  id: string,
  status: DeadLetter['status'],
  createdAt: string,
): DeadLetter {
  return {
    id,
    runId: `run-${id}`,
    nodeId: 'notify_finance',
    nodeType: 'approval',
    workflowName: 'Billing recovery',
    attempt: 1,
    status,
    createdAt,
    errorJson: { message: 'Finance approval timed out' },
  }
}

describe('activity feed model', () => {
  it('merges runs and recoveries chronologically with human workflow identity', () => {
    const feed = buildActivityFeed(
      [
        run('run-old', 'succeeded', '2026-07-28T09:00:00.000Z'),
        run('run-live', 'running', '2026-07-28T11:00:00.000Z'),
      ],
      [recovery('case-new', 'open', '2026-07-28T12:00:00.000Z')],
      workflows,
    )

    expect(feed.map(item => item.key)).toEqual([
      'recovery:case-new',
      'run:run-live',
      'run:run-old',
    ])
    expect(feed[1]).toMatchObject({
      workflowName: 'Billing recovery',
      category: 'running',
      nextAction: 'watch',
    })
  })

  it('projects the five user-facing filters without mislabeling normal success as recovery', () => {
    const recoveredRun = {
      ...run('run-semantic', 'succeeded', '2026-07-28T08:00:00.000Z'),
      outcomeStatus: 'semantic_recovered' as const,
    }
    const feed = buildActivityFeed(
      [
        run('run-live', 'running', '2026-07-28T12:00:00.000Z'),
        run('run-wait', 'waiting', '2026-07-28T11:00:00.000Z'),
        run('run-failed', 'failed', '2026-07-28T10:00:00.000Z'),
        run('run-done', 'succeeded', '2026-07-28T09:00:00.000Z'),
        recoveredRun,
      ],
      [
        recovery('case-open', 'open', '2026-07-28T07:00:00.000Z'),
        recovery('case-replayed', 'replayed', '2026-07-28T06:00:00.000Z'),
      ],
      workflows,
    )

    expect(filterActivityFeed(feed, 'running').map(item => item.key)).toEqual(['run:run-live'])
    expect(filterActivityFeed(feed, 'needs_action').map(item => item.key)).toEqual([
      'run:run-wait',
      'recovery:case-open',
    ])
    expect(filterActivityFeed(feed, 'failed').map(item => item.key)).toEqual(['run:run-failed'])
    expect(filterActivityFeed(feed, 'recovered').map(item => item.key)).toEqual([
      'run:run-semantic',
      'recovery:case-replayed',
    ])
    expect(countActivityFeed(feed)).toEqual({
      all: 7,
      running: 1,
      needs_action: 2,
      failed: 1,
      recovered: 2,
    })
  })

  it('classifies a running parent with a waiting node as needing action', () => {
    const waiting = run('run-waiting-node', 'running', '2026-07-28T12:00:00.000Z')
    waiting.hasWaitingNodes = true

    const feed = buildActivityFeed([waiting], [], workflows)

    expect(feed[0]?.category).toBe('needs_action')
    expect(feed[0]?.nextAction).toBe('reviewWait')
  })
})

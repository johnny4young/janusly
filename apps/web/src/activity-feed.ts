import type { RunSummary, SavedWorkflow } from './types'
import type { DeadLetter } from './components/DeadLettersPanel'
import { isOpenRunStatus } from '@janusly/shared/src/status'

export const ACTIVITY_FILTERS = [
  'all',
  'running',
  'needs_action',
  'failed',
  'recovered',
] as const

export type ActivityFilter = (typeof ACTIVITY_FILTERS)[number]
export type ActivityCategory = Exclude<ActivityFilter, 'all'> | 'completed'
export type ActivityNextAction =
  | 'watch'
  | 'reviewWait'
  | 'inspectFailure'
  | 'reviewOutcome'
  | 'recoverStep'
  | 'reviewReplay'
  | 'reviewResolution'

type ActivityFeedBase = {
  key: string
  entityId: string
  runId: string
  createdAt?: string
  workflowId?: string
  workflowName?: string | null
  category: ActivityCategory
  nextAction: ActivityNextAction
}

export type RunActivityFeedItem = ActivityFeedBase & {
  kind: 'run'
  run: RunSummary
}

export type RecoveryActivityFeedItem = ActivityFeedBase & {
  kind: 'recovery'
  deadLetter: DeadLetter
}

export type ActivityFeedItem = RunActivityFeedItem | RecoveryActivityFeedItem

function runCategory(run: RunSummary): ActivityCategory {
  if (run.status === 'failed' || run.status === 'timed_out' || run.status === 'cancelled') {
    return 'failed'
  }
  if (run.outcomeStatus === 'semantic_recovered') return 'recovered'
  if (run.hasWaitingNodes || run.status === 'waiting') {
    return 'needs_action'
  }
  if (isOpenRunStatus(run.status)) return 'running'
  return 'completed'
}

function runNextAction(category: ActivityCategory): ActivityNextAction {
  if (category === 'running') return 'watch'
  if (category === 'needs_action') return 'reviewWait'
  if (category === 'failed') return 'inspectFailure'
  return 'reviewOutcome'
}

function recoveryCategory(deadLetter: DeadLetter): ActivityCategory {
  return deadLetter.status === 'open' ? 'needs_action' : 'recovered'
}

function recoveryNextAction(deadLetter: DeadLetter): ActivityNextAction {
  if (deadLetter.status === 'open') return 'recoverStep'
  if (deadLetter.status === 'replayed') return 'reviewReplay'
  return 'reviewResolution'
}

function timestamp(value: string | undefined): number {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function buildActivityFeed(
  runs: RunSummary[],
  deadLetters: DeadLetter[],
  workflows: SavedWorkflow[],
): ActivityFeedItem[] {
  const workflowNames = new Map(workflows.map(workflow => [workflow.id, workflow.name]))
  const runItems: RunActivityFeedItem[] = runs.map(run => {
    const category = runCategory(run)
    return {
      key: `run:${run.id}`,
      entityId: run.id,
      runId: run.id,
      kind: 'run',
      run,
      createdAt: run.createdAt,
      workflowId: run.workflowId,
      workflowName: run.workflowName
        ?? (run.workflowId ? workflowNames.get(run.workflowId) : null),
      category,
      nextAction: runNextAction(category),
    }
  })
  const recoveryItems: RecoveryActivityFeedItem[] = deadLetters.map(deadLetter => ({
    key: `recovery:${deadLetter.id}`,
    entityId: deadLetter.id,
    runId: deadLetter.runId,
    kind: 'recovery',
    deadLetter,
    createdAt: deadLetter.createdAt,
    workflowName: deadLetter.workflowName,
    category: recoveryCategory(deadLetter),
    nextAction: recoveryNextAction(deadLetter),
  }))

  return [...runItems, ...recoveryItems].sort((left, right) => {
    const byTime = timestamp(right.createdAt) - timestamp(left.createdAt)
    if (byTime !== 0) return byTime
    if (left.category === 'needs_action' && right.category !== 'needs_action') return -1
    if (right.category === 'needs_action' && left.category !== 'needs_action') return 1
    return left.key.localeCompare(right.key)
  })
}

export function filterActivityFeed(
  feed: ActivityFeedItem[],
  filter: ActivityFilter,
): ActivityFeedItem[] {
  if (filter === 'all') return feed
  return feed.filter(item => item.category === filter)
}

export function countActivityFeed(
  feed: ActivityFeedItem[],
): Record<ActivityFilter, number> {
  const counts: Record<ActivityFilter, number> = {
    all: feed.length,
    running: 0,
    needs_action: 0,
    failed: 0,
    recovered: 0,
  }
  for (const item of feed) {
    if (item.category !== 'completed') counts[item.category] += 1
  }
  return counts
}

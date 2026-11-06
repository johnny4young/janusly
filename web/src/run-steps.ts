/** Per-step projection of one run: which attempts ran, when, and how they ended. */

import type { RunEvent, RunNode } from './types'

export type StepAttempt = {
  attempt: number
  outcome: string
  startedAt: number | null
  finishedAt: number | null
  error: string | null
}

export type RunStep = {
  nodeId: string
  status: string
  retries: number
  attempts: StepAttempt[]
}

export type RunStepProjection = {
  steps: RunStep[]
  startMs: number
  endMs: number
}

const CLOSING_OUTCOME: Record<string, string> = {
  'node.retry': 'retried',
  'node.failed': 'failed',
  'node.succeeded': 'succeeded',
  'node.completed': 'succeeded',
}

function toMs(value: string | null | undefined): number | null {
  const ms = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(ms) ? ms : null
}

function errorMessage(source: unknown): string | null {
  const message = (source as { message?: unknown } | null | undefined)?.message
  return typeof message === 'string' && message ? message : null
}

function attemptNumber(event: RunEvent, previous: StepAttempt | undefined): number {
  const value = event.payload?.attempt
  return typeof value === 'number' && value > 0 ? value : (previous?.attempt ?? 0) + 1
}

/** The run_nodes row is the authority for the attempt in progress: a subworkflow
 *  wait, for one, finishes without a closing node event. */
function reconcileWithRow(step: RunStep, node: RunNode): void {
  step.status = node.status
  step.retries = Math.max(step.retries, (node.attempts ?? 0) - 1)
  const last = step.attempts.at(-1)
  const startedAt = toMs(node.startedAt)
  if (!last) {
    if (startedAt !== null) {
      step.attempts.push({
        attempt: Math.max(1, node.attempts ?? 1),
        outcome: node.status,
        startedAt,
        finishedAt: toMs(node.finishedAt),
        error: errorMessage(node.errorJson),
      })
    }
    return
  }
  // A retried attempt is history; a requeued row describes the attempt to come.
  if (last.outcome === 'retried' || node.status === 'queued') return
  last.outcome = node.status
  last.finishedAt = toMs(node.finishedAt) ?? last.finishedAt
  last.error = errorMessage(node.errorJson) ?? last.error
}

export function projectRunSteps(events: readonly RunEvent[], nodes: readonly RunNode[]): RunStepProjection {
  const steps = new Map<string, RunStep>()
  const stepFor = (nodeId: string): RunStep => {
    let step = steps.get(nodeId)
    if (!step) {
      step = { nodeId, status: 'queued', retries: 0, attempts: [] }
      steps.set(nodeId, step)
    }
    return step
  }
  let lastEventMs: number | null = null

  // Array.sort is stable, so events sharing a millisecond keep their order.
  const chronological = [...events].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
  for (const event of chronological) {
    if (!event.nodeId) continue
    const step = stepFor(event.nodeId)
    const at = toMs(event.createdAt)
    lastEventMs = at ?? lastEventMs
    const last = step.attempts.at(-1)
    const closing = CLOSING_OUTCOME[event.type]
    if (event.type === 'node.running') {
      const attempt = attemptNumber(event, last)
      if (last?.attempt === attempt) last.outcome = 'running'
      else step.attempts.push({ attempt, outcome: 'running', startedAt: at, finishedAt: null, error: null })
    } else if (event.type === 'node.waiting' && last) {
      last.outcome = 'waiting'
    } else if (closing) {
      if (event.type === 'node.retry') step.retries += 1
      if (last) {
        last.outcome = closing
        last.finishedAt = at
        last.error = errorMessage(event.payload?.error) ?? last.error
      }
    }
  }
  for (const node of nodes) reconcileWithRow(stepFor(node.nodeId), node)

  const list = [...steps.values()]
  const times = list.flatMap(step => step.attempts.flatMap(item => [item.startedAt, item.finishedAt]))
    .filter((value): value is number => value !== null)
  if (lastEventMs !== null) times.push(lastEventMs)
  return {
    steps: list,
    startMs: times.length > 0 ? Math.min(...times) : 0,
    endMs: times.length > 0 ? Math.max(...times) : 0,
  }
}

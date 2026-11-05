import { normalizeErrorSignature } from '../lib/error-signature'
import type { ClusterCategory, FailureCluster } from '../lib/recovery-metrics-model'
import type {
  BulkReplayResult,
  BulkResolveResult,
  DeadLetter,
} from './dead-letter-types'

export const BULK_ERROR_PREVIEW = 6

export function isBulkResolveResult(value: unknown): value is BulkResolveResult {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<BulkResolveResult>
  return typeof candidate.resolved === 'number'
    && typeof candidate.failed === 'number'
    && Array.isArray(candidate.errors)
}

export function isBulkReplayResult(value: unknown): value is BulkReplayResult {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<BulkReplayResult>
  return typeof candidate.replayed === 'number'
    && typeof candidate.failed === 'number'
    && Array.isArray(candidate.errors)
}

export function triageQueueSignature(items: DeadLetter[]): string {
  return items.map((item) => `${item.id}:${item.status}`).join('|')
}

export function deadLetterRowTone(
  status: DeadLetter['status'],
): 'danger' | 'success' | 'cobalt' {
  if (status === 'open') return 'danger'
  if (status === 'replayed') return 'success'
  return 'cobalt'
}

export type QueueClusterGroup = {
  signature: string
  category: ClusterCategory
  frequency: number
  workflowNames: string[]
  rows: DeadLetter[]
}

export type QueueListItem =
  | { kind: 'cluster'; group: QueueClusterGroup }
  | { kind: 'row'; item: DeadLetter }

/**
 * Group the loaded rows with the normalizer the server clusters with, so every
 * filter and page still applies. Groups keep the order of their first row, which
 * honors the chosen sort. The rollup adds totals; a row outside its window, or a
 * failed rollup read, still groups with what the loaded rows say.
 */
export function groupQueueByCluster(rows: readonly DeadLetter[], clusters: readonly FailureCluster[]): QueueClusterGroup[] {
  const rollup = new Map(clusters.map((cluster) => [cluster.signature, cluster]))
  const groups = new Map<string, QueueClusterGroup>()
  for (const item of rows) {
    const { signature, category } = normalizeErrorSignature(item.errorJson, { nodeType: item.nodeType ?? undefined })
    const group = groups.get(signature)
    if (group) {
      group.rows.push(item)
      continue
    }
    groups.set(signature, { signature, category, frequency: 0, workflowNames: [], rows: [item] })
  }
  return [...groups.values()].map((group) => {
    const cluster = rollup.get(group.signature)
    const loadedNames = group.rows.flatMap((row) => row.workflowName ?? [])
    return {
      ...group,
      category: cluster?.category ?? group.category,
      frequency: Math.max(cluster?.frequency ?? 0, group.rows.length),
      workflowNames: cluster?.affectedWorkflows.map((workflow) => workflow.workflowName) ?? [...new Set(loadedNames)],
    }
  })
}

export function queueListItems(rows: readonly DeadLetter[], groups: readonly QueueClusterGroup[] | null): QueueListItem[] {
  if (!groups) return rows.map((item) => ({ kind: 'row', item }))
  return groups.flatMap((group): QueueListItem[] => [
    { kind: 'cluster', group },
    ...group.rows.map((item): QueueListItem => ({ kind: 'row', item })),
  ])
}

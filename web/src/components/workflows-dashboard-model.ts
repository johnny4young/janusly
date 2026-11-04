import type { FlowsSort } from '../flows-filters'
import type { SavedWorkflow } from '../types'

export const UNGROUPED_FOLDER = ''

export function updateCollapsedFolders(
  current: string[],
  key: string,
  open: boolean,
): string[] {
  const collapsed = current.includes(key)
  if (open && collapsed) return current.filter((entry) => entry !== key)
  if (!open && !collapsed) return [...current, key]
  return current
}

const FAILED_RUN_STATUSES = new Set(['failed', 'cancelled', 'timed_out'])

/** Failed last run first, then paused, then any other run, then never run. */
function statusRank(workflow: SavedWorkflow): number {
  if (workflow.lastRunStatus && FAILED_RUN_STATUSES.has(workflow.lastRunStatus)) return 0
  if (workflow.status && workflow.status !== 'active') return 1
  return workflow.lastRunStatus ? 2 : 3
}

function recency(workflow: SavedWorkflow): string {
  return workflow.lastRunAt ?? workflow.updatedAt ?? workflow.createdAt ?? ''
}

/** Sorts loaded rows, most recent first on ties. A score that has not arrived
 *  stays last in either direction so loading rows never pass for the extremes. */
export function sortFlows(
  workflows: SavedWorkflow[],
  sort: FlowsSort,
  healthScores: Readonly<Record<string, number>>,
  locale: string,
): SavedWorkflow[] {
  const sign = sort.direction === 'asc' ? 1 : -1
  const compare = (a: SavedWorkflow, b: SavedWorkflow): number => {
    switch (sort.key) {
      case 'name': return sign * a.name.localeCompare(b.name, locale)
      case 'status': return sign * (statusRank(a) - statusRank(b))
      case 'openFailures': return sign * ((a.openFailureCount ?? 0) - (b.openFailureCount ?? 0))
      case 'version': return sign * ((a.currentVersion ?? 0) - (b.currentVersion ?? 0))
      case 'lastRun': return sign * recency(a).localeCompare(recency(b))
      case 'health': {
        const scoreA = healthScores[a.id]
        const scoreB = healthScores[b.id]
        if (scoreA === undefined || scoreB === undefined) {
          return Number(scoreA === undefined) - Number(scoreB === undefined)
        }
        return sign * (scoreA - scoreB)
      }
    }
  }
  return [...workflows].sort((a, b) => compare(a, b) || recency(b).localeCompare(recency(a)))
}

import type { WorkflowDefinition } from '../types'
import type { RecoveryDrillOutcome } from './recovery/RecoveryDrillOutcomeCard'

/** Recovery-item projection folded onto a recovery-queue row. */
export type DeadLetterRecovery = {
  id: string
  owner: string | null
  severity: 'p1' | 'p2' | 'p3' | 'p4'
  status: string
  slaTargetAt: string
  resolutionReason: string | null
  comments: Array<{ id: string; authorUserId: string; body: string; createdAt: string }>
  workflowId?: string | null
  metadataWorkflowId?: string | null
  occurrenceCount?: number
  lastOccurredAt?: string
}

/** Recent workflow-version correlation returned by the selected-row detail read. */
export type SuspectVersionInfo = {
  workflowId: string
  version: number
  versionId: string
  savedAt: string
  previousVersion: number
  previousVersionId: string
  dagJson: WorkflowDefinition
  previousDagJson: WorkflowDefinition
}

/** Bounded provenance for a code-authored recovery drill. */
export type RecoveryDrillProvenance = {
  kind: 'solution_pack_drill'
  packId: string
  fixtureId: string
  recoveryPath: 'direct_failure' | 'stalled_node_reaper'
}

/** Web projection of one dead-letter row. List reads omit snapshot fields. */
export type DeadLetter = {
  id: string
  runId: string
  nodeId: string
  attempt: number
  status: 'open' | 'replayed' | 'resolved' | string
  workflowJson?: unknown
  nodeJson?: unknown
  errorJson: unknown
  nodeType?: string | null
  workflowName?: string | null
  createdAt?: string
  replayedAt?: string
  recovery?: DeadLetterRecovery | null
  suspectVersion?: SuspectVersionInfo | null
  drill?: RecoveryDrillProvenance | null
  drillOutcome?: RecoveryDrillOutcome | null
}

export type BulkResolveResult = {
  resolved: number
  failed: number
  errors: Array<{ deadLetterId: string; error: string }>
}

export type BulkReplayResult = {
  replayed: number
  failed: number
  errors: Array<{ deadLetterId: string; error: string }>
}

export type BulkDeadLetterError = BulkResolveResult['errors'][number]

export type PendingTriageFocus = {
  actionId: string
  neighborIds: string[]
  fallbackIndex: number
  queueSignature: string
  settled: boolean
}

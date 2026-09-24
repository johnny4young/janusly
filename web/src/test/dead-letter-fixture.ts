import type { DeadLetterDetail } from '../lib/dead-letter-contract'

// Complete HTTP detail fixture; summary tests deliberately omit snapshots.
export const deadLetterWireDefaults = {
  id: 'dead-letter', orgId: 'org', runId: 'run', nodeId: 'node', attempt: 1,
  status: 'open', workflowJson: null, nodeJson: null, errorJson: null,
  createdAt: null, replayedAt: null, replayClaimedAt: null,
  suspectVersion: null, drill: null, drillOutcome: null,
} satisfies DeadLetterDetail

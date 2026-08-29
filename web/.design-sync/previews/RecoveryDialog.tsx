import { RecoveryDialog } from '@janusly/web'
import { deadLetter } from './_fixtures'
import { Stage } from './_stage'

/**
 * The full recovery flow for a failed run: it reads the failure, proposes
 * patches, validates the chosen one, and applies it as a new workflow version.
 *
 * Cluster mode is the second job. When `clusterMembers` is set, the same patch
 * is applied to every listed dead letter instead of just this one — which is
 * why `clusterMembersCapped` and `clusterMembersTotal` exist: the operator has
 * to know they are acting on 200 incidents when only 50 are listed.
 *
 * Known copy defect in cluster mode, visible in the second cell: the match
 * count is printed twice — "matches 3 3 open DLQ entries" uncapped, and
 * "matches 3 of 31 3 open DLQ entries" when the member list is capped. A stray
 * emphasis element repeats what the counted string already renders. Do not
 * copy that composition; it is filed for repair.
 */

/** A single incident. */
export function SingleIncident() {
  return (
    <Stage minHeight={820}>
      <RecoveryDialog dlq={deadLetter} onClose={() => {}} />
    </Stage>
  )
}

/** Cluster mode: one patch applied to every dead letter sharing the signature. */
export function ClusterMode() {
  return (
    <Stage minHeight={820}>
      <RecoveryDialog
        dlq={deadLetter}
        onClose={() => {}}
        clusterSignature="HTTP 503 from billing.acme.com"
        clusterMembers={['dlq_4f2a91', 'dlq_7c1e08', 'dlq_2b9f44']}
        clusterMembersTotal={3}
      />
    </Stage>
  )
}

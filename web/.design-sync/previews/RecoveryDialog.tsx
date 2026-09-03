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
 * The cluster line puts the count in one place — an emphasised "3 of 31" —
 * and follows it with a noun that agrees with the total, not the visible
 * slice: one entry out of thirty-one is still "entries".
 */

/** A single incident. */
export function SingleIncident() {
  return (
    <Stage minHeight={820}>
      <RecoveryDialog dlq={deadLetter} onClose={() => {}} />
    </Stage>
  )
}

/**
 * Cluster mode with the member list capped below the true total: one patch
 * covers every dead letter sharing the signature, and the operator is told they
 * are acting on 31 incidents while only 3 are listed.
 */
export function ClusterMode() {
  return (
    <Stage minHeight={820}>
      <RecoveryDialog
        dlq={deadLetter}
        onClose={() => {}}
        clusterSignature="HTTP 503 from billing.acme.com"
        clusterMembers={['dlq_4f2a91', 'dlq_7c1e08', 'dlq_2b9f44']}
        clusterMembersCapped
        clusterMembersTotal={31}
      />
    </Stage>
  )
}

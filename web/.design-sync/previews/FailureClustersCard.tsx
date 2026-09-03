import { FailureClustersCard } from '@janusly/web'

/**
 * Groups the week's failures by signature so an operator triages three causes
 * instead of sixty-eight incidents. Each cluster carries its frequency, the
 * workflows it touches, when it was first and last seen, and a suggested owner
 * — `ops`, `workflow_author`, or `platform` — which is the routing decision the
 * card exists to make.
 *
 * `canRecover` gates the per-cluster replay action; without the permission the
 * same evidence renders read-only. The two states differ only by that control,
 * so a single story is shown rather than a pair that reads as duplicated.
 *
 * Clusters come from `GET /dlq/clusters` on mount.
 */
export function Triage() {
  return <FailureClustersCard canRecover />
}

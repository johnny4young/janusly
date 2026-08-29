import { ReplayCampaignsCard } from '@janusly/web'

/**
 * In-flight replay campaigns — a bulk re-run across many dead letters.
 * `canCancel` gates the stop control; the campaign list comes from the store.
 */

/** An operator who can stop a running campaign. */
export function Cancellable() {
  return <ReplayCampaignsCard canCancel />
}

/** A viewer — progress visible, no stop control. */
export function ReadOnly() {
  return <ReplayCampaignsCard canCancel={false} />
}

import { ReplayCampaignDialog } from '@janusly/web'
import { Stage } from './_stage'

/**
 * Starts a bulk replay across many dead letters at once — the escalation from
 * replaying one. The id list is the input; pacing and safety limits are the
 * dialog's own.
 */

/** A small batch. */
export function SmallBatch() {
  return (
    <Stage>
      <ReplayCampaignDialog
        deadLetterIds={['dlq_4f2a91', 'dlq_8c31d0', 'dlq_1b77ae']}
        onClose={() => {}}
        onCreated={() => {}}
      />
    </Stage>
  )
}

/** A large batch, where pacing actually matters. */
export function LargeBatch() {
  return (
    <Stage>
      <ReplayCampaignDialog
        deadLetterIds={Array.from({ length: 128 }, (_, i) => `dlq_${(i + 1).toString(16).padStart(6, '0')}`)}
        onClose={() => {}}
        onCreated={() => {}}
      />
    </Stage>
  )
}

import { RecoveryItemDrawer } from '@janusly/web'
import { recoveryItem } from './_fixtures'

/**
 * The full incident record behind a `RecoveryItemBadge`: severity, ownership,
 * SLA target, resolution reason, and the operator comment trail.
 */

/** An acknowledged p2 with two comments on it. */
export function Acknowledged() {
  return <RecoveryItemDrawer item={recoveryItem} onClose={() => {}} />
}

/** A fresh, unowned p1 with nothing recorded against it yet. */
export function UnownedWithNoComments() {
  return (
    <RecoveryItemDrawer
      item={{
        ...recoveryItem,
        id: 'ri_4f2a91',
        owner: null,
        severity: 'p1',
        status: 'open',
        slaTargetAtIso: '2026-08-27T17:00:00.000Z',
        comments: [],
      }}
      onClose={() => {}}
    />
  )
}

/** Closed out, carrying its resolution reason. */
export function Resolved() {
  return (
    <RecoveryItemDrawer
      item={{ ...recoveryItem, status: 'resolved', resolutionReason: 'recovered' as never }}
      onClose={() => {}}
    />
  )
}

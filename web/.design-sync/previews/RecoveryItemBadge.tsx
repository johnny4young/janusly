import { RecoveryItemBadge } from '@janusly/web'

/**
 * The incident chip for a recovery item: severity, lifecycle status, owner,
 * and how many DLQ failures the debounce window collapsed into this one
 * incident. `occurrenceCount` of 1 means a single failure.
 */

/** A p1 nobody has picked up yet — the most urgent shape. */
export function UnownedP1() {
  return (
    <RecoveryItemBadge
      item={{
        id: 'ri_4f2a91',
        owner: null,
        severity: 'p1',
        status: 'open',
        slaTargetAtIso: '2026-09-01T17:00:00.000Z',
        occurrenceCount: 1,
      }}
    />
  )
}

/** Acknowledged and owned, with several failures folded into one incident. */
export function AcknowledgedP2() {
  return (
    <RecoveryItemBadge
      item={{
        id: 'ri_8c31d0',
        owner: 'dana@acme.com',
        severity: 'p2',
        status: 'acknowledged',
        slaTargetAtIso: '2026-09-02T09:30:00.000Z',
        occurrenceCount: 14,
      }}
      onOpen={() => {}}
    />
  )
}

/** Work in flight on a lower-severity item. */
export function InProgressP3() {
  return (
    <RecoveryItemBadge
      item={{
        id: 'ri_1b77ae',
        owner: 'sam@acme.com',
        severity: 'p3',
        status: 'in_progress',
        slaTargetAtIso: '2026-09-03T12:00:00.000Z',
        occurrenceCount: 3,
      }}
      onOpen={() => {}}
    />
  )
}

/** Closed out. */
export function ResolvedP4() {
  return (
    <RecoveryItemBadge
      item={{
        id: 'ri_02de55',
        owner: 'dana@acme.com',
        severity: 'p4',
        status: 'resolved',
        slaTargetAtIso: '2026-09-08T12:00:00.000Z',
        occurrenceCount: 1,
      }}
    />
  )
}

// Note: `item={null}` is a supported input — the component returns null — but
// it makes an empty card cell, so it is documented here rather than shown.

import { LearningHealthBadge } from '@janusly/web'

/**
 * How fresh the recovery learning is for one approach. `state` is the signal:
 * `active` means a fix of this kind was accepted recently, `stale` means the
 * last accepted fix is old enough to distrust, and `no_accepted_fix` means
 * feedback exists but nothing was ever accepted — the badge exists so an
 * operator does not read a confident suggestion as a proven one.
 */

const snapshot = (
  approachLabel: 'raise_timeout' | 'add_retry' | 'swap_secret_ref',
  state: 'active' | 'stale' | 'no_accepted_fix',
  acceptedFixAgeDays: number | null,
  acceptedFixLastSeen: string | null,
) => ({
  windowDays: 90,
  approaches: [
    {
      approachLabel,
      state,
      acceptedFixAgeDays,
      acceptedFixLastSeen,
      feedbackLastSeen: '2026-08-24T02:07:41.000Z',
    },
  ],
})

/** Recent accepted fix — the learning is current. */
export function Active() {
  return (
    <LearningHealthBadge
      approachLabel="raise_timeout"
      feedbackHealth={snapshot('raise_timeout', 'active', 4, '2026-08-23T02:07:41.000Z')}
    />
  )
}

/** The last accepted fix is old enough to treat with caution. */
export function Stale() {
  return (
    <LearningHealthBadge
      approachLabel="add_retry"
      feedbackHealth={snapshot('add_retry', 'stale', 74, '2026-06-14T09:30:00.000Z')}
    />
  )
}

/** Feedback exists, but no fix of this kind was ever accepted. */
export function NoAcceptedFix() {
  return (
    <LearningHealthBadge
      approachLabel="swap_secret_ref"
      feedbackHealth={snapshot('swap_secret_ref', 'no_accepted_fix', null, null)}
    />
  )
}

// Note: with no `feedbackHealth` the badge renders nothing at all, which is
// correct but makes an empty card cell — documented here rather than shown.

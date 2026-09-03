import { ActivityRecoveryDetail } from '@janusly/web'
import { deadLetter } from './_fixtures'

/**
 * One dead letter, opened from the activity feed: what failed, on which run and
 * node, how many attempts it took before giving up, and the two ways out —
 * replay it, or resolve it as accepted loss.
 *
 * The four `can*` flags are independent permissions, not one switch. A workspace
 * can allow resolving without allowing replay, because a replay re-executes
 * side effects and resolving does not.
 *
 * `onReplay` and `onResolve` may return a boolean or a promise of one; `false`
 * tells the detail to keep the row open because the action did not take.
 *
 * `initialDetail` hands the full row straight in; without it the detail fetches
 * `GET /dlq?id=…` and holds a loading state until it lands.
 */

const handlers = {
  onOpenRun: () => {},
  onReplay: () => true,
  onResolve: () => true,
}

/** An operator who can do both. */
export function FullRecoveryAccess() {
  return (
    <ActivityRecoveryDetail
      deadLetter={deadLetter}
      initialDetail={deadLetter}
      {...handlers}
      canReplay
      canResolve
      canStartRuns
      canUseRecovery
    />
  )
}

/** Resolve allowed, replay withheld — the common split. */
export function ResolveOnly() {
  return (
    <ActivityRecoveryDetail
      deadLetter={deadLetter}
      initialDetail={deadLetter}
      {...handlers}
      canReplay={false}
      canResolve
      canStartRuns={false}
      canUseRecovery
    />
  )
}

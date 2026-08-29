import { DeadLetterDetail } from '@janusly/web'
import { deadLetter } from './_fixtures'

/**
 * The right-hand pane of the recovery queue: what the selected failure was, and
 * what can be done about it.
 *
 * Props arrive in three groups on purpose — `selection` (what is picked and how
 * far its detail has loaded), `permissions` (four independent capabilities),
 * and `actions` (the callbacks). Reading them apart is the point: a workspace
 * routinely allows resolving without allowing replay, because a replay
 * re-executes side effects.
 *
 * `selected` is the queue row; `selectedFull` is the complete record fetched
 * afterwards. Until `selectedDetailReady` is true the pane shows the row's
 * summary rather than a spinner, so the actions stay reachable while the
 * evidence is still arriving.
 */

const actions = {
  startRecovery: () => {},
  replaySelected: async () => {},
  resolveSelected: async () => {},
  copySelectedError: async () => {},
  openReplayLab: () => {},
  exportRunExplain: async () => {},
  toggleSuspectDiff: () => {},
}

const selection = {
  requestedNotFound: false,
  selectionMode: false,
  selected: deadLetter,
  selectedFull: deadLetter,
  selectedDetailReady: true,
  replayingIds: new Set<string>(),
  showSuspectDiff: false,
}

/** An operator with the full recovery capability. */
export function FullAccess() {
  return (
    <DeadLetterDetail
      selection={selection}
      permissions={{ canReplay: true, canResolve: true, canStartRuns: true, canUseRecovery: true }}
      actions={actions}
    />
  )
}

/** Resolve allowed, replay withheld — the common permission split. */
export function ResolveOnly() {
  return (
    <DeadLetterDetail
      selection={selection}
      permissions={{ canReplay: false, canResolve: true, canStartRuns: false, canUseRecovery: true }}
      actions={actions}
    />
  )
}

/** A replay already in flight for this row. */
export function ReplayInFlight() {
  return (
    <DeadLetterDetail
      selection={{ ...selection, replayingIds: new Set([deadLetter.id]) }}
      permissions={{ canReplay: true, canResolve: true, canStartRuns: true, canUseRecovery: true }}
      actions={actions}
    />
  )
}

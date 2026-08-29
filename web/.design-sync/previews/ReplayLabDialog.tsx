import { ReplayLabDialog } from '@janusly/web'
import { Stage } from './_stage'
import { sourceRun } from './_fixtures'

/**
 * Re-runs a past run in the replay lab, isolated from production. The source
 * run is the only input — everything else the dialog resolves itself.
 */

/** Replaying a failed run. */
export function FailedRun() {
  return (
    <Stage>
      <ReplayLabDialog sourceRun={sourceRun} onClose={() => {}} />
    </Stage>
  )
}

/** Replaying one that succeeded, to test a change against a known-good path. */
export function SucceededRun() {
  return (
    <Stage>
      <ReplayLabDialog
        sourceRun={{ ...sourceRun, id: 'run_02de55', status: 'succeeded' }}
        onClose={() => {}}
      />
    </Stage>
  )
}

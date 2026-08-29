import { ReplayLabForkDialog } from '@janusly/web'
import { Stage } from './_stage'
import { sourceRun } from './_fixtures'

/**
 * Forks a run from a chosen step: everything before `forkNodeId` is replayed
 * from the recorded trace, and execution goes live from that step onward.
 */

/** Forking at the step that failed. */
export function ForkAtFailedStep() {
  return (
    <Stage>
      <ReplayLabForkDialog sourceRun={sourceRun} forkNodeId="fetch_invoice" onClose={() => {}} />
    </Stage>
  )
}

/** Forking later in the graph, after the fetch already succeeded. */
export function ForkDownstream() {
  return (
    <Stage>
      <ReplayLabForkDialog sourceRun={sourceRun} forkNodeId="compare" onClose={() => {}} />
    </Stage>
  )
}

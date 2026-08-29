import { RunObservationWorkspace } from '@janusly/web'
import { runNodes, runSummary } from './_fixtures'

/**
 * The layout an operator reads a run in: an immutable companion canvas of the
 * run's graph on one side, and a caller-supplied inspector `panel` on the
 * other.
 *
 * The canvas is deliberately a *separate* React Flow instance from the editor's,
 * so observing a run can never disturb authoring selection, graph state, or the
 * saved editor viewport. It brings its own `ReactFlowProvider`, which is why
 * this surface can be previewed at all while the bare canvas pieces cannot.
 *
 * React Flow measures its container on mount, so the workspace needs a parent
 * with real height — inside a zero-height box it mounts and draws nothing.
 */
export function FailedRun() {
  return (
    <div style={{ height: 520, display: 'flex' }}>
      <RunObservationWorkspace
        run={runSummary}
        runNodes={runNodes}
        panel={
          <div style={{ padding: '1rem' }}>
            <p>
              <strong>fetch_invoice</strong> failed on attempt 3 of 3.
            </p>
            <p>HTTP 503 from billing.acme.com after 30000ms — upstream did not respond.</p>
          </div>
        }
      />
    </div>
  )
}

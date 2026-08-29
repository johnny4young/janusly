import { ReportDeliveryDialog } from '@janusly/web'
import { sourceRun } from './_fixtures'
import { Stage } from './_stage'

/**
 * Sends a generated report somewhere an operator's team will actually read it.
 *
 * The dialog is deliberately reusable: `endpoint` and `copyKeys` retarget it,
 * so the same surface delivers a run explanation and an incident evidence
 * bundle. Passing `sourceRun` adds the run summary section and puts
 * `{ runId }` in the request body; omitting it delivers the report alone.
 */

/** Run-explain delivery — the default endpoint and copy. */
export function WithSourceRun() {
  return (
    <Stage minHeight={680}>
      <ReportDeliveryDialog sourceRun={sourceRun} onClose={() => {}} />
    </Stage>
  )
}

/** Incident evidence delivery — retargeted at the recovery endpoint. */
export function EvidenceBundle() {
  return (
    <Stage minHeight={680}>
      <ReportDeliveryDialog
        endpoint="/recovery/items/ri_8c31d0/evidence/deliver"
        onClose={() => {}}
      />
    </Stage>
  )
}

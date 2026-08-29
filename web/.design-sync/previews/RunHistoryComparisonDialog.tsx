import { RunHistoryComparisonDialog } from '@janusly/web'
import { runSummary } from './_fixtures'
import { Stage } from './_stage'

/**
 * Compares one run against its baseline from the run history, so an operator
 * can see what changed between a run that worked and one that did not.
 *
 * The comparison is fetched on open; until it arrives the dialog holds a
 * loading state, and it says so plainly when the baseline is missing rather
 * than showing an empty diff.
 */
export function FailedRun() {
  return (
    <Stage>
      <RunHistoryComparisonDialog
        selectedRun={{
          ...runSummary,
          workflowId: 'wf_invoice_recon',
          createdAt: '2026-08-26T02:00:00.000Z',
        }}
        workflowLabel="Invoice reconciliation"
        onClose={() => {}}
      />
    </Stage>
  )
}

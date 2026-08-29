import { WorkflowReadinessBadge } from '@janusly/web'

/**
 * The pre-publish check. It posts the current workflow to
 * `POST /workflows/readiness` and summarises the result as `pass`, `warn`, or
 * `fail`, with the issue list one click away via `onOpenProblems`.
 *
 * `warn` is the interesting state and the one shown: the workflow is
 * publishable, but two steps call external hosts without a retry or a timeout.
 * `onResult` lets a parent mirror the verdict into its own toolbar.
 *
 * The verdict is derived from the workflow, not from props, so one story.
 */
export function NeedsAttention() {
  return <WorkflowReadinessBadge onOpenProblems={() => {}} />
}

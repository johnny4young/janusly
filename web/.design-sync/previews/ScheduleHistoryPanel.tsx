import { ScheduleHistoryPanel } from '@janusly/web'

/**
 * Past fires of a workflow's cron schedule, bucketed by day of week and hour,
 * with the success/fail split in each cell. The point of the grid is the shape:
 * a red anomaly cell against an otherwise green column is a schedule problem,
 * not a workflow problem.
 *
 * `workflowId` is optional — omitted, the panel takes the current workflow from
 * the store, which is how the operations column mounts it. That fallback is not
 * shown as its own cell: with a workflow selected it renders exactly what the
 * explicit binding below renders, and with none it renders nothing at all.
 */
export function ForWorkflow() {
  return <ScheduleHistoryPanel workflowId="wf_invoice_recon" />
}

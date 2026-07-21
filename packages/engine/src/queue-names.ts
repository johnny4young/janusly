/** Stable BullMQ queue names shared by delivery and bounded observability. */

/** Customer workflow, trigger, checkpoint, and paced replay delivery lane. */
export const WORKFLOW_QUEUE_NAME = "workflow-nodes";

/** Platform sweep, reconciliation, calibration, and purge delivery lane. */
export const MAINTENANCE_QUEUE_NAME = "maintenance-jobs";

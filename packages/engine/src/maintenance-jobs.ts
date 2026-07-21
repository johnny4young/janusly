/**
 * Isolated maintenance-job catalog, dispatcher, and queue migration seam.
 *
 * Used by `worker.ts` to register recurring maintenance schedules, process
 * the dedicated `maintenance-jobs` queue, and drain jobs materialized by an
 * older release on `workflow-nodes` without dropping repair work.
 *
 * Invariants:
 * - Customer execution jobs never enter this catalog.
 * - A scheduler is registered on the maintenance queue before its legacy
 *   workflow-queue scheduler is retired.
 * - Legacy retirement is best-effort. The workflow worker retains this same
 *   dispatcher so already-materialized jobs remain executable during rollout.
 */

import {
  AUDIT_LOGS_RETENTION_JOB_ID,
  AUDIT_LOGS_RETENTION_JOB_NAME,
  handleAuditLogsRetentionTrigger,
  registerAuditLogsRetentionScheduler,
} from "./audit-logs-retention-scheduler";
import {
  CONFIDENCE_CALIBRATION_JOB_ID,
  CONFIDENCE_CALIBRATION_JOB_NAME,
  handleConfidenceCalibrationTrigger,
  registerConfidenceCalibrationScheduler,
} from "./confidence-calibration-scheduler";
import {
  handleMemoryBulkPurgeTrigger,
  MEMORY_BULK_PURGE_JOB_NAME,
} from "./memory-purge-scheduler";
import {
  handleMemoryRetentionTrigger,
  MEMORY_RETENTION_JOB_ID,
  MEMORY_RETENTION_JOB_NAME,
  registerMemoryRetentionScheduler,
} from "./memory-retention-scheduler";
import {
  handleQueuePublicationReconcilerTrigger,
  QUEUE_PUBLICATION_RECONCILER_JOB_ID,
  QUEUE_PUBLICATION_RECONCILER_JOB_NAME,
  registerQueuePublicationReconciler,
} from "./queue-publication-reconciler";
import {
  handleReplayCampaignReconcilerTrigger,
  registerReplayCampaignReconciler,
  REPLAY_CAMPAIGN_RECONCILER_JOB_ID,
  REPLAY_CAMPAIGN_RECONCILER_JOB_NAME,
} from "./replay-campaign";
import {
  handleRetentionTrigger,
  registerRetentionScheduler,
  RETENTION_JOB_ID,
  RETENTION_JOB_NAME,
} from "./retention-scheduler";
import {
  handleScimEventsRetentionTrigger,
  registerScimEventsRetentionScheduler,
  SCIM_EVENTS_RETENTION_JOB_ID,
  SCIM_EVENTS_RETENTION_JOB_NAME,
} from "./scim-events-retention-scheduler";
import {
  handleStalledNodeReaperTrigger,
  registerStalledNodeReaperScheduler,
  STALLED_NODE_REAPER_JOB_ID,
  STALLED_NODE_REAPER_JOB_NAME,
} from "./stalled-node-reaper";
import {
  handleSubworkflowTerminalReconcilerTrigger,
  registerSubworkflowTerminalReconciler,
  SUBWORKFLOW_TERMINAL_RECONCILER_JOB_ID,
  SUBWORKFLOW_TERMINAL_RECONCILER_JOB_NAME,
} from "./subworkflow-terminal-reconciler";
import {
  handleUpstreamHealthTrigger,
  registerUpstreamHealthScheduler,
  UPSTREAM_HEALTH_JOB_ID,
  UPSTREAM_HEALTH_JOB_NAME,
} from "./upstream-health-poller";
import {
  handleWaitingCheckpointReconcilerTrigger,
  registerWaitingCheckpointReconciler,
  WAITING_CHECKPOINT_RECONCILER_JOB_ID,
  WAITING_CHECKPOINT_RECONCILER_JOB_NAME,
} from "./waiting-checkpoint-reconciler";
import {
  handleWorkflowRolloutReconcilerTrigger,
  registerWorkflowRolloutReconciler,
  WORKFLOW_ROLLOUT_RECONCILER_JOB_ID,
  WORKFLOW_ROLLOUT_RECONCILER_JOB_NAME,
} from "./workflow-rollout-reconciler";
import { workflowQueue } from "./queue";
import {
  migrateMaintenanceSchedulers,
  type MaintenanceSchedulerSpec,
} from "./maintenance-control";

/** Re-export the pure concurrency resolver for worker boot. */
export { resolveMaintenanceWorkerConcurrency } from "./maintenance-control";

/** Closed list of recurring work owned by the maintenance queue. */
export const MAINTENANCE_SCHEDULERS: readonly MaintenanceSchedulerSpec[] = [
  { id: MEMORY_RETENTION_JOB_ID, label: "memory-retention", register: registerMemoryRetentionScheduler },
  { id: AUDIT_LOGS_RETENTION_JOB_ID, label: "audit-logs-retention", register: registerAuditLogsRetentionScheduler },
  { id: SCIM_EVENTS_RETENTION_JOB_ID, label: "scim-events-retention", register: registerScimEventsRetentionScheduler },
  { id: RETENTION_JOB_ID, label: "retention", register: registerRetentionScheduler },
  { id: UPSTREAM_HEALTH_JOB_ID, label: "upstream-health", register: registerUpstreamHealthScheduler },
  { id: CONFIDENCE_CALIBRATION_JOB_ID, label: "confidence-calibration", register: registerConfidenceCalibrationScheduler },
  { id: STALLED_NODE_REAPER_JOB_ID, label: "stalled-node-reaper", register: registerStalledNodeReaperScheduler },
  { id: WAITING_CHECKPOINT_RECONCILER_JOB_ID, label: "waiting-checkpoint-reconciler", register: registerWaitingCheckpointReconciler },
  { id: QUEUE_PUBLICATION_RECONCILER_JOB_ID, label: "queue-publication-reconciler", register: registerQueuePublicationReconciler },
  { id: SUBWORKFLOW_TERMINAL_RECONCILER_JOB_ID, label: "subworkflow-terminal-reconciler", register: registerSubworkflowTerminalReconciler },
  { id: WORKFLOW_ROLLOUT_RECONCILER_JOB_ID, label: "workflow-rollout-reconciler", register: registerWorkflowRolloutReconciler },
  { id: REPLAY_CAMPAIGN_RECONCILER_JOB_ID, label: "replay-campaign-reconciler", register: registerReplayCampaignReconciler },
];

/**
 * Register each future recurrence on `maintenance-jobs`, then retire only the
 * corresponding legacy scheduler from `workflow-nodes` after success.
 */
export async function registerAndMigrateMaintenanceSchedulers(
): Promise<import("./maintenance-control").MaintenanceSchedulerMigrationResult> {
  return migrateMaintenanceSchedulers(MAINTENANCE_SCHEDULERS, workflowQueue);
}

/**
 * Dispatch one maintenance job. Returns false for customer or unknown jobs so
 * the caller can apply its own validation and poison-job policy.
 */
export async function dispatchMaintenanceJob(name: string, data: unknown): Promise<boolean> {
  switch (name) {
    case MEMORY_RETENTION_JOB_NAME:
      await handleMemoryRetentionTrigger();
      return true;
    case AUDIT_LOGS_RETENTION_JOB_NAME:
      await handleAuditLogsRetentionTrigger();
      return true;
    case SCIM_EVENTS_RETENTION_JOB_NAME:
      await handleScimEventsRetentionTrigger();
      return true;
    case RETENTION_JOB_NAME:
      await handleRetentionTrigger();
      return true;
    case UPSTREAM_HEALTH_JOB_NAME:
      await handleUpstreamHealthTrigger();
      return true;
    case CONFIDENCE_CALIBRATION_JOB_NAME:
      await handleConfidenceCalibrationTrigger();
      return true;
    case STALLED_NODE_REAPER_JOB_NAME:
      await handleStalledNodeReaperTrigger();
      return true;
    case WAITING_CHECKPOINT_RECONCILER_JOB_NAME:
      await handleWaitingCheckpointReconcilerTrigger();
      return true;
    case QUEUE_PUBLICATION_RECONCILER_JOB_NAME:
      await handleQueuePublicationReconcilerTrigger();
      return true;
    case SUBWORKFLOW_TERMINAL_RECONCILER_JOB_NAME:
      await handleSubworkflowTerminalReconcilerTrigger();
      return true;
    case WORKFLOW_ROLLOUT_RECONCILER_JOB_NAME:
      await handleWorkflowRolloutReconcilerTrigger();
      return true;
    case REPLAY_CAMPAIGN_RECONCILER_JOB_NAME:
      await handleReplayCampaignReconcilerTrigger();
      return true;
    case MEMORY_BULK_PURGE_JOB_NAME:
      await handleMemoryBulkPurgeTrigger(data as { orgId: string });
      return true;
    default:
      return false;
  }
}

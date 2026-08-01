/** Registry segment for executors already owned by focused modules. */

import { joinExecutor, parallelForkExecutor } from "../parallel-fork";
import { scheduleExecutor } from "../schedule";
import { subworkflowExecutor } from "../subworkflow";
import {
  emailReceivedExecutor,
  fileDroppedExecutor,
  mcpServerEventExecutor,
  pagerDutyIncidentExecutor,
  webhookReceivedExecutor,
} from "../triggers";
import { waitUntilExecutor } from "../wait-until";
import type { NodeExecutorMap } from "./types";

export const delegatedNodeExecutors = {
  // Subworkflow node — async pause-and-resume against a child run.
  // Implementation lives in `subworkflow.ts`; this module only composes
  // focused executors into one registry segment.
  subworkflow: subworkflowExecutor,

  // wait_until node — pauses the run for a configurable ISO 8601 duration.
  // The wake-up is handled by a delayed BullMQ job dispatched in `worker.ts`
  // on `job.name === "wait-resume"`.
  wait_until: waitUntilExecutor,

  // parallel_fork / join — DAG fan-out / fan-in pair. Both are declarative
  // shells over the existing runtime semantics: the fan-out is "this node
  // has multiple outgoing edges", the fan-in is the runtime's existing
  // ALL-AND readiness check (every predecessor must be `succeeded` or
  // `skipped` before the join queues), and the atomic single-claim of the
  // join is the existing `tryClaimNodeForQueue` UPDATE...WHERE...pending
  // guard. The executors here only validate and shape outputs.
  parallel_fork: parallelForkExecutor,
  join: joinExecutor,

  // schedule node — passthrough trigger. The cron firing is owned by a
  // BullMQ scheduler registered by `schedule-scheduler.ts` on workflow
  // save; the executor itself just succeeds with `triggeredAt` so
  // downstream nodes have a stable output to read.
  schedule: scheduleExecutor,

  // Event-driven trigger nodes — passthrough triggers (like `schedule`).
  // The actual firing happens at the API ingestion seam
  // (`trigger-ingest-routes.ts`): it persists a structured `trigger_events`
  // row, applies a per-trigger rate-limit storm guard, and spawns a run via
  // `startRun` with the normalized inbound event as the run input. The
  // executors here just succeed with `{ triggeredBy, event }` so downstream
  // nodes can read the inbound payload.
  webhook_received: webhookReceivedExecutor,
  email_received: emailReceivedExecutor,
  file_dropped: fileDroppedExecutor,
  mcp_server_event: mcpServerEventExecutor,
  pagerduty_incident: pagerDutyIncidentExecutor,
} satisfies Pick<
  NodeExecutorMap,
  | "subworkflow"
  | "wait_until"
  | "parallel_fork"
  | "join"
  | "schedule"
  | "webhook_received"
  | "email_received"
  | "file_dropped"
  | "mcp_server_event"
  | "pagerduty_incident"
>;

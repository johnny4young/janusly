/**
 * Pure helper that maps `(trigger, payload)` → a stable dedupeKey string.
 *
 * The dedupeKey is the part of the cooldown lookup that absorbs the
 * trigger-specific signature so two events that share root cause collapse
 * into one alert (with cooldown), but two events on the same trigger with
 * different root causes still fire separately.
 *
 * One branch per trigger. Pure function — no I/O, easy to unit test.
 */

import type { AlertTrigger } from "@janusly/shared";

const NO_KEY = "__none__";

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}

/** Build the per-trigger dedupeKey. Returns `NO_KEY` when no salient key
 *  can be derived from the payload — the dispatcher still suppresses
 *  re-firing within `cooldownSeconds` based on this single key. */
export function buildDedupeKey(trigger: AlertTrigger, payload: Record<string, unknown>): string {
  switch (trigger) {
    case "dlq.entry_created": {
      const sig = asString(payload.errorSignature);
      return sig ? `sig:${sig}` : NO_KEY;
    }
    case "failure_cluster.threshold": {
      const sig = asString(payload.signature);
      return sig ? `cluster:${sig}` : NO_KEY;
    }
    case "budget.blocked": {
      const scope = asString(payload.scope) ?? "org";
      const workflowId = asString(payload.workflowId);
      return workflowId ? `budget:${scope}:${workflowId}` : `budget:${scope}`;
    }
    case "limiter.degraded": {
      const bucket = asString(payload.bucket);
      return bucket ? `bucket:${bucket}` : NO_KEY;
    }
    case "workflow.slo_breach": {
      const workflowId = asString(payload.workflowId);
      const metrics = Array.isArray(payload.metricNames)
        ? [...payload.metricNames]
            .filter((m): m is string => typeof m === "string")
            .sort()
            .join(",")
        : "";
      if (!workflowId) return NO_KEY;
      return metrics ? `slo:${workflowId}:${metrics}` : `slo:${workflowId}`;
    }
    case "approval.stalled": {
      const runId = asString(payload.runId);
      const nodeId = asString(payload.nodeId);
      if (!runId || !nodeId) return NO_KEY;
      return `approval:${runId}:${nodeId}`;
    }
    case "recovery_item.created": {
      const deadLetterId = asString(payload.deadLetterId);
      return deadLetterId ? `item:${deadLetterId}` : NO_KEY;
    }
    case "recovery_item.sla_breached": {
      const itemId = asString(payload.itemId);
      return itemId ? `sla:${itemId}` : NO_KEY;
    }
    case "workflow.schedule_anomaly": {
      // Per-workflow key: one alert per workflow per cooldown summarises all
      // its anomalous slots, rather than spamming one alert per slot.
      const workflowId = asString(payload.workflowId);
      return workflowId ? `schedule:${workflowId}` : NO_KEY;
    }
    default:
      return NO_KEY;
  }
}

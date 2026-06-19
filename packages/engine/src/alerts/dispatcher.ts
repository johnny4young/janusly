/**
 * Production dispatcher for the recovery alerting subsystem. Registered
 * via `setAlertDispatcher` from `@janusly/data/src/alert-dispatch` at BOTH
 * API and worker boot — events fired from the worker (DLQ inserts, future
 * worker-side hooks) reach the dispatcher in-process the same way
 * api-side events (budget-gate) do.
 *
 * Lives in `@janusly/engine` (not `apps/api`) so both processes can
 * register the same function. Audit writes happen inline via
 * `db.insert(auditLogs)` + the shared `safePersistPayload` chokepoint
 * (same posture as `autoHealingRepo.ts` and `rate-limit-degradation.ts`)
 * because the api-side `audit()` helper isn't importable from engine.
 *
 * Invariants:
 *  - Never throws. Per-channel failures land as `{ ok: false, error, latencyMs }`.
 *  - Secrets scrubbed via `scrubSecretShapes` inside `composeAlertMessage`
 *    AND via `safePersistPayload` on the persisted audit metadata.
 *  - Dedupe lookup happens BEFORE channel fan-out; cooldown skips only
 *    write `alert.policy.suppressed` audit (no `alert_dispatches` row).
 */

import { db, auditLogs } from "@janusly/db";
import {
  composeAlertMessage,
  matchGlob,
  type AlertChannel,
  type AlertChannelResult,
  type AlertOutcome,
  type AlertParamsByTrigger,
} from "@janusly/shared";
import {
  getEnabledPoliciesByTrigger,
  type AlertPolicy,
  getLastDispatchAt,
  recordDispatch,
  type AlertEvent,
} from "@janusly/data";

import { executeTool } from "../tool-registry";
import {
  callGithubCreateIssue,
  callSlackPost,
  callWebhookSend,
} from "../integration-dispatch";
import { safePersistPayload } from "../safe-persist";
import { buildDedupeKey } from "./dedupe-key";

const AUDIT_METADATA_MAX_BYTES = 64_000;
const RECOVERY_CENTER_URL = (() => {
  const base = process.env.JANUSLY_PUBLIC_APP_URL?.replace(/\/$/, "");
  return base ? `${base}/operations` : undefined;
})();

/**
 * Inline audit writer used by the dispatcher. Mirrors `apps/api/src/audit.ts`
 * exactly — same `safePersistPayload` chokepoint, same 64 KB cap, same
 * never-throw posture. Lives here because engine cannot import from api.
 */
async function writeAuditRow(input: {
  orgId: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      orgId: input.orgId,
      userId: "system",
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      metadata: safePersistPayload(input.metadata, { maxBytes: AUDIT_METADATA_MAX_BYTES }),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[alerts] audit write failed", { action: input.action, err });
  }
}

/**
 * Apply the per-trigger `parameters` filter from the policy against the
 * event payload. Returns true when the policy matches the event.
 */
export function matchesPolicyFilter(
  policy: AlertPolicy,
  payload: Record<string, unknown>,
): boolean {
  const params = policy.parameters ?? {};

  switch (policy.trigger) {
    case "dlq.entry_created": {
      const p = params as Partial<AlertParamsByTrigger["dlq.entry_created"]>;
      if (typeof p.errorSignaturePattern === "string" && p.errorSignaturePattern.length > 0) {
        const sig = typeof payload.errorSignature === "string" ? payload.errorSignature : "";
        if (!matchGlob(p.errorSignaturePattern, sig)) return false;
      }
      if (Array.isArray(p.workflowIds) && p.workflowIds.length > 0) {
        const workflowId = typeof payload.workflowId === "string" ? payload.workflowId : "";
        if (!p.workflowIds.includes(workflowId)) return false;
      }
      return true;
    }
    case "failure_cluster.threshold": {
      const p = params as Partial<AlertParamsByTrigger["failure_cluster.threshold"]>;
      const frequency = typeof payload.frequency === "number" ? payload.frequency : 0;
      const minFrequency = typeof p.minFrequency === "number" ? p.minFrequency : 2;
      const policyWindowDays = typeof p.windowDays === "number" ? p.windowDays : 7;
      const payloadWindowDays = typeof payload.windowDays === "number" ? payload.windowDays : policyWindowDays;
      if (payloadWindowDays !== policyWindowDays) return false;
      return frequency >= minFrequency;
    }
    case "budget.blocked": {
      const p = params as Partial<AlertParamsByTrigger["budget.blocked"]>;
      if (p.scope && payload.scope !== p.scope) return false;
      if (Array.isArray(p.workflowIds) && p.workflowIds.length > 0) {
        const workflowId = typeof payload.workflowId === "string" ? payload.workflowId : "";
        if (!p.workflowIds.includes(workflowId)) return false;
      }
      return true;
    }
    case "limiter.degraded": {
      const p = params as Partial<AlertParamsByTrigger["limiter.degraded"]>;
      if (Array.isArray(p.buckets) && p.buckets.length > 0) {
        const bucket = typeof payload.bucket === "string" ? payload.bucket : "";
        if (!p.buckets.includes(bucket)) return false;
      }
      return true;
    }
    case "workflow.slo_breach": {
      const p = params as Partial<AlertParamsByTrigger["workflow.slo_breach"]>;
      if (Array.isArray(p.workflowIds) && p.workflowIds.length > 0) {
        const workflowId = typeof payload.workflowId === "string" ? payload.workflowId : "";
        if (!p.workflowIds.includes(workflowId)) return false;
      }
      if (Array.isArray(p.metricNames) && p.metricNames.length > 0) {
        const payloadMetrics = Array.isArray(payload.metricNames)
          ? payload.metricNames.filter((m): m is string => typeof m === "string")
          : [];
        const overlap = payloadMetrics.some((m) => p.metricNames!.includes(m as never));
        if (!overlap) return false;
      }
      return true;
    }
    case "approval.stalled": {
      const p = params as Partial<AlertParamsByTrigger["approval.stalled"]>;
      const stalledMinutes = typeof payload.stalledMinutes === "number" ? payload.stalledMinutes : 0;
      const threshold = typeof p.stalledMinutes === "number" ? p.stalledMinutes : Number.POSITIVE_INFINITY;
      if (stalledMinutes < threshold) return false;
      if (Array.isArray(p.workflowIds) && p.workflowIds.length > 0) {
        const workflowId = typeof payload.workflowId === "string" ? payload.workflowId : "";
        if (!p.workflowIds.includes(workflowId)) return false;
      }
      return true;
    }
    case "recovery_item.created":
    case "recovery_item.sla_breached": {
      const p = params as Partial<AlertParamsByTrigger["recovery_item.created"]>;
      if (Array.isArray(p.severities) && p.severities.length > 0) {
        const severity = typeof payload.severity === "string" ? payload.severity : "";
        if (!p.severities.includes(severity as never)) return false;
      }
      if (Array.isArray(p.workflowIds) && p.workflowIds.length > 0) {
        const workflowId = typeof payload.workflowId === "string" ? payload.workflowId : "";
        if (!p.workflowIds.includes(workflowId)) return false;
      }
      return true;
    }
    case "workflow.schedule_anomaly": {
      const p = params as Partial<AlertParamsByTrigger["workflow.schedule_anomaly"]>;
      if (Array.isArray(p.workflowIds) && p.workflowIds.length > 0) {
        const workflowId = typeof payload.workflowId === "string" ? payload.workflowId : "";
        if (!p.workflowIds.includes(workflowId)) return false;
      }
      return true;
    }
    default:
      return true;
  }
}

// ─── Channel dispatch ──────────────────────────────────────────────────────

type ChannelDispatchInput = {
  orgId: string;
  channel: AlertChannel;
  subject: string;
  markdown: string;
  structured: Record<string, unknown>;
};

async function dispatchOneChannel(input: ChannelDispatchInput): Promise<AlertChannelResult> {
  const started = Date.now();
  const base = { destination: input.channel.destination, credentialName: input.channel.credentialName };

  try {
    let result: Record<string, unknown> | undefined;
    switch (input.channel.destination) {
      case "slack":
        result = await callSlackPost(
          { orgId: input.orgId },
          { credential: input.channel.credentialName, text: input.markdown },
        );
        break;
      case "webhook": {
        const url = (input.channel.params as { url?: string } | undefined)?.url;
        if (!url) {
          return { ...base, ok: false, error: "webhook url missing", latencyMs: Date.now() - started };
        }
        result = await callWebhookSend(
          { orgId: input.orgId },
          { credential: input.channel.credentialName, url, payload: input.structured },
        );
        break;
      }
      case "github": {
        const params = (input.channel.params as
          | { owner?: string; repo?: string; labels?: string[]; assignees?: string[] }
          | undefined) ?? {};
        if (!params.owner || !params.repo) {
          return {
            ...base,
            ok: false,
            error: "github owner/repo missing",
            latencyMs: Date.now() - started,
          };
        }
        result = await callGithubCreateIssue(
          { orgId: input.orgId },
          {
            credential: input.channel.credentialName,
            owner: params.owner,
            repo: params.repo,
            title: input.subject,
            body: input.markdown,
            labels: params.labels,
            assignees: params.assignees,
          },
        );
        break;
      }
      case "email": {
        const params = (input.channel.params as
          | { to?: string | string[]; subject?: string }
          | undefined) ?? {};
        const to = Array.isArray(params.to) ? params.to[0] : params.to;
        if (!to) {
          return { ...base, ok: false, error: "email recipient missing", latencyMs: Date.now() - started };
        }
        result = await executeTool(
          "email.send",
          { to, subject: params.subject ?? input.subject, text: input.markdown },
          {},
          { orgId: input.orgId },
        );
        break;
      }
      default:
        return {
          ...base,
          ok: false,
          error: `unknown destination: ${input.channel.destination}`,
          latencyMs: Date.now() - started,
        };
    }

    const ok = result?.ok === true;
    const statusCodeRaw = result?.statusCode;
    const errorRaw = result?.error;
    return {
      ...base,
      ok,
      statusCode:
        typeof statusCodeRaw === "number" && Number.isFinite(statusCodeRaw)
          ? Math.trunc(statusCodeRaw)
          : null,
      error: typeof errorRaw === "string" ? errorRaw.slice(0, 1000) : null,
      latencyMs: Date.now() - started,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      ok: false,
      error: message.slice(0, 1000),
      latencyMs: Date.now() - started,
    };
  }
}

// ─── Top-level dispatch ────────────────────────────────────────────────────

export async function dispatchAlert(event: AlertEvent): Promise<void> {
  let policies: AlertPolicy[];
  try {
    policies = await getEnabledPoliciesByTrigger(event.orgId, event.trigger);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[alerts] failed to load policies", {
      err,
      orgId: event.orgId,
      trigger: event.trigger,
    });
    return;
  }
  if (policies.length === 0) return;

  for (const policy of policies) {
    try {
      await dispatchAgainstPolicy(policy, event);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[alerts] dispatchAgainstPolicy threw — should never happen", {
        err,
        policyId: policy.id,
      });
    }
  }
}

async function dispatchAgainstPolicy(policy: AlertPolicy, event: AlertEvent): Promise<void> {
  if (!matchesPolicyFilter(policy, event.payload)) return;

  const dedupeKey = buildDedupeKey(event.trigger, event.payload);

  let lastDispatchedAt: Date | null = null;
  try {
    lastDispatchedAt = await getLastDispatchAt(policy.orgId, policy.id, dedupeKey);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[alerts] cooldown lookup failed — proceeding without dedup", {
      err,
      policyId: policy.id,
    });
  }
  if (lastDispatchedAt) {
    const cooldownExpiresAt = new Date(
      lastDispatchedAt.getTime() + policy.cooldownSeconds * 1_000,
    );
    if (cooldownExpiresAt.getTime() > Date.now()) {
      await writeAuditRow({
        orgId: policy.orgId,
        action: "alert.policy.suppressed",
        targetType: "alert-policy",
        targetId: policy.id,
        metadata: {
          trigger: event.trigger,
          dedupeKey,
          cooldownSeconds: policy.cooldownSeconds,
          cooldownExpiresAt: cooldownExpiresAt.toISOString(),
        },
      });
      return;
    }
  }

  const message = composeAlertMessage({
    policyName: policy.name,
    trigger: event.trigger,
    triggerPayload: event.payload,
    recoveryCenterUrl: RECOVERY_CENTER_URL,
  });

  const channelResults: AlertChannelResult[] = [];
  for (const channel of policy.channels) {
    const result = await dispatchOneChannel({
      orgId: policy.orgId,
      channel,
      subject: message.subject,
      markdown: message.markdown,
      structured: message.structured,
    });
    channelResults.push(result);
  }

  const outcome: AlertOutcome = channelResults.some((r) => r.ok) ? "delivered" : "delivery_failed";

  try {
    await recordDispatch({
      orgId: policy.orgId,
      policyId: policy.id,
      dedupeKey,
      outcome,
      channelResults,
      triggerPayload: message.structured.payload,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[alerts] recordDispatch failed", { err, policyId: policy.id });
  }

  await writeAuditRow({
    orgId: policy.orgId,
    action: "alert.policy.triggered",
    targetType: "alert-policy",
    targetId: policy.id,
    metadata: {
      trigger: event.trigger,
      dedupeKey,
      outcome,
      channelResults,
      triggerPayload: message.structured.payload,
    },
  });
}

export { dispatchOneChannel as __dispatchOneChannelForTests };

/**
 * Periodic scanner for the six state-driven alert triggers:
 *   - `failure_cluster.threshold` — re-cluster recent failure samples and
 *     fire when a cluster's frequency crosses the policy's `minFrequency`.
 *   - `workflow.slo_breach` — re-evaluate SLO breaches per workflow with
 *     `slo_json IS NOT NULL`.
 *   - `approval.stalled` — find `run_nodes` waiting for human approval
 *     longer than `policy.parameters.stalledMinutes`.
 *   - `recovery_item.sla_breached` — find open recovery items past their
 *     SLA target.
 *   - `workflow.schedule_anomaly` — re-bucket each actively-scheduled
 *     workflow's recent fires and fire when a day/hour slot's failure rate
 *     diverges above the schedule baseline.
 *   - `credential.expiring` — find credentials whose operator-declared
 *     expiry is inside an enabled policy's warning window.
 *
 * Event-driven triggers (`dlq.entry_created`, `budget.blocked`,
 * `limiter.degraded`, `recovery_item.created`) fire in-process via the DI
 * seam and do NOT use this scanner.
 *
 * Bootstrap behaviour:
 *   - Registered as a single deterministic BullMQ scheduler
 *     `system:alerts-scanner` running every 2 min by default
 *     (env-tunable via `JANUSLY_ALERTS_SCAN_CRON`).
 *   - Never throws — per-org failures are caught and console-warned so a
 *     single tenant's bad state can't stall the others.
 *   - Skips entirely when `JANUSLY_ALERTS_ENABLED !== "true"`.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { db, runNodes, runs, scheduleEntries, workflowVersions } from "@janusly/db";

import {
  evaluateWorkflowSlo,
  type AlertTrigger,
  type AlertParamsByTrigger,
  type WorkflowSlo,
} from "@janusly/shared";
import {
  queryFailureSamples,
  queryHealthSignals,
  queryScheduleFiresByWorkflow,
  listOpenItemsWithBreachedSla,
  listCredentialsExpiringWithin,
  getEnabledPoliciesByTrigger,
  listOrgIdsWithEnabledPolicies,
  type AlertPolicy,
} from "@janusly/data";
import { clusterFailureSamples } from "@janusly/engine/src/cluster-failures";
import {
  bucketScheduleFires,
  MAX_FIRE_ROWS,
  MAX_HISTORY_DAYS,
} from "@janusly/engine/src/schedule-history";

import { dispatchAlert } from "@janusly/engine/src/alerts/dispatcher";

/** Defensive cap on how many actively-scheduled workflows a single org scan
 *  will fire-query + bucket per tick, so a tenant with thousands of schedules
 *  can't make one scan unbounded. */
const SCHEDULE_ANOMALY_MAX_WORKFLOWS = 200;

export const ALERTS_SCAN_JOB_ID = "system:alerts-scanner";
export const ALERTS_SCAN_JOB_NAME = "alerts-scan-trigger";
export const DEFAULT_ALERTS_SCAN_CRON = "*/2 * * * *";

/** Hard cap on samples per (orgId, scan) for failure-cluster evaluation. */
const FAILURE_SAMPLE_LIMIT = 500;
/** Default lookback window when the policy doesn't override it. */
const FAILURE_DEFAULT_WINDOW_DAYS = 7;

// ─── Cron registration ─────────────────────────────────────────────────────

export async function registerAlertsScannerScheduler(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const pattern = resolveCronPattern(env);
  try {
    const { alertsQueue } = await import("./alerts-queue");
    await alertsQueue.upsertJobScheduler(
      ALERTS_SCAN_JOB_ID,
      { pattern },
      { name: ALERTS_SCAN_JOB_NAME, data: {} },
    );
    return true;
  } catch (err) {
    console.error("[alerts] scanner registration failed", {
      jobId: ALERTS_SCAN_JOB_ID,
      err,
    });
    return false;
  }
}

function resolveCronPattern(env: NodeJS.ProcessEnv): string {
  const raw = env.JANUSLY_ALERTS_SCAN_CRON?.trim();
  if (!raw) return DEFAULT_ALERTS_SCAN_CRON;
  if (!/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(raw)) {
    console.warn("[alerts] JANUSLY_ALERTS_SCAN_CRON invalid; falling back to default", {
      value: raw,
      default: DEFAULT_ALERTS_SCAN_CRON,
    });
    return DEFAULT_ALERTS_SCAN_CRON;
  }
  return raw;
}

// ─── Scan entry point ──────────────────────────────────────────────────────

export async function handleAlertsScanTrigger(): Promise<void> {
  if (process.env.JANUSLY_ALERTS_ENABLED !== "true") return;

  let orgIds: string[];
  try {
    orgIds = await listOrgIdsWithEnabledPolicies();
  } catch (err) {
    console.error("[alerts] failed to list orgs with enabled policies", { err });
    return;
  }

  // Bounded worker pool over orgs. Strictly sequential scanning is a
  // throughput ceiling at fleet scale (each org scan is itself a series of
  // queries — worst case hundreds per org), and one slow org would push the
  // whole sweep past its own cron interval. A small fixed concurrency keeps
  // DB pressure bounded; the shared cursor increment is safe on the
  // single-threaded event loop.
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(ALERTS_SCAN_ORG_CONCURRENCY, orgIds.length) },
    async () => {
      while (cursor < orgIds.length) {
        const orgId = orgIds[cursor];
        cursor += 1;
        if (!orgId) continue;
        try {
          await runOrgScan(orgId);
        } catch (err) {
          console.error("[alerts] runOrgScan threw — should never happen", { orgId, err });
        }
      }
    },
  );
  await Promise.all(workers);
}

/** How many org scans run concurrently per sweep. Small and fixed — enough to
 *  stop one slow org serializing the fleet, low enough to bound DB pressure. */
const ALERTS_SCAN_ORG_CONCURRENCY = 4;

async function runOrgScan(orgId: string): Promise<void> {
  await scanFailureClusters(orgId);
  await scanWorkflowSloBreaches(orgId);
  await scanStalledApprovals(orgId);
  await scanRecoveryItemSlaBreaches(orgId);
  await scanScheduleAnomalies(orgId);
  await scanCredentialExpiry(orgId);
}

// ─── failure_cluster.threshold ─────────────────────────────────────────────

async function scanFailureClusters(orgId: string): Promise<void> {
  const policies = await getEnabledPoliciesByTrigger(orgId, "failure_cluster.threshold");
  if (policies.length === 0) return;

  const windows = new Set<number>();
  for (const policy of policies) {
    const wd = (policy.parameters as Partial<AlertParamsByTrigger["failure_cluster.threshold"]>).windowDays
      ?? FAILURE_DEFAULT_WINDOW_DAYS;
    windows.add(wd);
  }

  for (const windowDays of windows) {
    let samples: Awaited<ReturnType<typeof queryFailureSamples>>;
    try {
      samples = await queryFailureSamples(orgId, windowDays, FAILURE_SAMPLE_LIMIT);
    } catch (err) {
      console.warn("[alerts] failure sample collection failed", { orgId, windowDays, err });
      continue;
    }
    if (samples.length === 0) continue;

    const clusters = clusterFailureSamples(samples);
    for (const cluster of clusters) {
      if (cluster.frequency < 2) continue;
      await dispatchAlert({
        orgId,
        trigger: "failure_cluster.threshold",
        payload: {
          signature: cluster.signature,
          frequency: cluster.frequency,
          windowDays,
          sampleRunIds: cluster.samples.map((s) => s.runId).slice(0, 10),
          affectedWorkflows: cluster.affectedWorkflows.map((w) => w.workflowName),
        },
      });
    }
  }
}

// ─── workflow.slo_breach ───────────────────────────────────────────────────

async function scanWorkflowSloBreaches(orgId: string): Promise<void> {
  const policies = await getEnabledPoliciesByTrigger(orgId, "workflow.slo_breach");
  if (policies.length === 0) return;

  // Find workflows with an SLO declared. Latest version per workflow only.
  let candidates: { workflowId: string; slo: WorkflowSlo }[];
  try {
    candidates = await listWorkflowsWithSlo(orgId);
  } catch (err) {
    console.warn("[alerts] listWorkflowsWithSlo failed", { orgId, err });
    return;
  }
  if (candidates.length === 0) return;

  for (const candidate of candidates) {
    let signals: Awaited<ReturnType<typeof queryHealthSignals>>;
    try {
      signals = await queryHealthSignals(orgId, candidate.workflowId, candidate.slo.windowDays);
    } catch (err) {
      console.warn("[alerts] signals collection failed", { orgId, workflowId: candidate.workflowId, err });
      continue;
    }

    const breaches = evaluateWorkflowSlo(candidate.slo, {
      totalRuns: signals.totalRuns,
      successCount: signals.successCount,
      p95LatencyMs: signals.p95LatencyMs ?? null,
    });
    if (!breaches.anyBreach) continue;

    const metricNames: string[] = [];
    if (breaches.successRatePercent) metricNames.push("successRate");
    if (breaches.p95DurationMs) metricNames.push("p95");
    if (metricNames.length === 0) continue;

    await dispatchAlert({
      orgId,
      trigger: "workflow.slo_breach",
      payload: {
        workflowId: candidate.workflowId,
        metricNames,
        totalRuns: signals.totalRuns,
        successRatePercent: (signals.successCount / Math.max(signals.totalRuns, 1)) * 100,
        p95LatencyMs: signals.p95LatencyMs ?? null,
      },
    });
  }
}

async function listWorkflowsWithSlo(
  orgId: string,
): Promise<{ workflowId: string; slo: WorkflowSlo }[]> {
  // Pull every version, then collapse to latest-per-workflow in JS — the
  // latest row decides whether an SLO is currently declared. Filtering
  // `slo_json IS NOT NULL` in SQL would resurrect a cleared SLO from an
  // older version.
  const rows = await db
    .select({
      workflowId: workflowVersions.workflowId,
      version: workflowVersions.version,
      sloJson: workflowVersions.sloJson,
    })
    .from(workflowVersions)
    .where(eq(workflowVersions.orgId, orgId));

  const latestByWorkflow = new Map<string, { version: number; slo: WorkflowSlo | null }>();
  for (const row of rows) {
    const existing = latestByWorkflow.get(row.workflowId);
    if (!existing || row.version > existing.version) {
      latestByWorkflow.set(row.workflowId, {
        version: row.version,
        slo: (row.sloJson as WorkflowSlo | null) ?? null,
      });
    }
  }
  return Array.from(latestByWorkflow, ([workflowId, value]) => ({ workflowId, slo: value.slo }))
    .filter((entry): entry is { workflowId: string; slo: WorkflowSlo } => entry.slo !== null);
}

// ─── approval.stalled ──────────────────────────────────────────────────────

async function scanStalledApprovals(orgId: string): Promise<void> {
  const policies = await getEnabledPoliciesByTrigger(orgId, "approval.stalled");
  if (policies.length === 0) return;

  // Use the smallest declared stalledMinutes for the SQL filter; per-policy
  // re-filter happens in the dispatcher.
  let minThresholdMinutes = Number.POSITIVE_INFINITY;
  for (const policy of policies) {
    const stalledMinutes = (policy.parameters as Partial<AlertParamsByTrigger["approval.stalled"]>).stalledMinutes;
    if (typeof stalledMinutes === "number" && stalledMinutes < minThresholdMinutes) {
      minThresholdMinutes = stalledMinutes;
    }
  }
  if (!Number.isFinite(minThresholdMinutes)) return;

  const cutoff = new Date(Date.now() - minThresholdMinutes * 60_000);

  let stuck: { runId: string; nodeId: string; workflowId: string | null; startedAt: Date }[];
  try {
    const rows = await db
      .select({
        runId: runNodes.runId,
        nodeId: runNodes.nodeId,
        workflowId: workflowVersions.workflowId,
        startedAt: runNodes.startedAt,
      })
      .from(runNodes)
      .innerJoin(runs, eq(runs.id, runNodes.runId))
      .leftJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
      .where(
        and(
          eq(runs.orgId, orgId),
          eq(runNodes.status, "waiting"),
          sql`${runNodes.stateJson} #>> '{waiting,reason}' = 'Waiting for human approval'`,
          sql`COALESCE(${runNodes.startedAt}, ${runs.createdAt}) <= ${cutoff}`,
        ),
      )
      .limit(200);
    stuck = rows.map((r) => ({
      runId: r.runId,
      nodeId: r.nodeId,
      workflowId: r.workflowId ?? null,
      startedAt: r.startedAt ?? cutoff,
    }));
  } catch (err) {
    console.warn("[alerts] stalled-approvals query failed", { orgId, err });
    return;
  }

  for (const row of stuck) {
    const stalledMinutes = Math.floor((Date.now() - row.startedAt.getTime()) / 60_000);
    await dispatchAlert({
      orgId,
      trigger: "approval.stalled",
      payload: {
        runId: row.runId,
        nodeId: row.nodeId,
        workflowId: row.workflowId,
        stalledMinutes,
      },
    });
  }
}

// ─── recovery_item.sla_breached ────────────────────────────────────────────

async function scanRecoveryItemSlaBreaches(orgId: string): Promise<void> {
  const policies = await getEnabledPoliciesByTrigger(orgId, "recovery_item.sla_breached");
  if (policies.length === 0) return;

  let breached: Awaited<ReturnType<typeof listOpenItemsWithBreachedSla>>;
  try {
    breached = await listOpenItemsWithBreachedSla(orgId);
  } catch (err) {
    console.warn("[alerts] listOpenItemsWithBreachedSla failed", { orgId, err });
    return;
  }

  for (const item of breached) {
    await dispatchAlert({
      orgId,
      trigger: "recovery_item.sla_breached",
      payload: {
        itemId: item.id,
        deadLetterId: item.deadLetterId,
        workflowId: item.workflowId,
        severity: item.severity,
        status: item.status,
        owner: item.owner,
        slaTargetAtIso: item.slaTargetAt.toISOString(),
        breachedBySeconds: Math.max(0, Math.floor((Date.now() - item.slaTargetAt.getTime()) / 1000)),
      },
    });
  }
}

// ─── credential.expiring ───────────────────────────────────────────────────

async function scanCredentialExpiry(orgId: string): Promise<void> {
  const policies = await getEnabledPoliciesByTrigger(orgId, "credential.expiring");
  if (policies.length === 0) return;

  // Query once using the WIDEST window any policy cares about (the largest
  // warnDays); per-policy narrowing happens in matchesPolicyFilter via the
  // payload's computed daysUntil. Default 30 when a policy omits warnDays
  // (schema requires it, but be defensive against a hand-written row).
  let maxWarnDays = 0;
  for (const policy of policies) {
    const wd = (policy.parameters as Partial<AlertParamsByTrigger["credential.expiring"]>).warnDays ?? 30;
    if (typeof wd === "number" && wd > maxWarnDays) maxWarnDays = wd;
  }
  if (maxWarnDays <= 0) return;

  let expiring: Awaited<ReturnType<typeof listCredentialsExpiringWithin>>;
  try {
    expiring = await listCredentialsExpiringWithin(orgId, maxWarnDays);
  } catch (err) {
    console.warn("[alerts] listCredentialsExpiringWithin failed", { orgId, err });
    return;
  }

  for (const cred of expiring) {
    // Whole days until expiry (>= 0). Already-expired credentials report 0 so a
    // policy with any warnDays still fires. `ceil` so "1.2 days left" → 2 days,
    // matching the operator's "warn N days ahead" mental model.
    const daysUntil = Math.max(0, Math.ceil((cred.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
    await dispatchAlert({
      orgId,
      trigger: "credential.expiring",
      payload: {
        credentialId: cred.id,
        name: cred.name,
        kind: cred.kind,
        // Days until this credential expires (>= 0). The dispatcher's per-policy
        // filter fires only when this is <= the policy's `warnDays` threshold.
        daysUntilExpiry: daysUntil,
        expiresAtIso: cred.expiresAt.toISOString(),
      },
    });
  }
}

// ─── workflow.schedule_anomaly ─────────────────────────────────────────────

async function scanScheduleAnomalies(orgId: string): Promise<void> {
  const policies = await getEnabledPoliciesByTrigger(orgId, "workflow.schedule_anomaly");
  if (policies.length === 0) return;
  const scanTarget = collectScheduleAnomalyWorkflowTargets(policies);

  let workflowIds: string[];
  try {
    workflowIds = await listScheduledWorkflowIds(orgId, scanTarget);
  } catch (err) {
    console.warn("[alerts] listScheduledWorkflowIds failed", { orgId, err });
    return;
  }
  if (workflowIds.length === 0) return;

  // ONE batched query for the whole scheduled set (per-workflow newest-first
  // cap preserved via the repo's window function) — this scan previously
  // issued up to ~200 sequential per-workflow queries per org per cron tick.
  let firesByWorkflow: Awaited<ReturnType<typeof queryScheduleFiresByWorkflow>>;
  try {
    firesByWorkflow = await queryScheduleFiresByWorkflow(orgId, workflowIds, MAX_HISTORY_DAYS, MAX_FIRE_ROWS);
  } catch (err) {
    console.warn("[alerts] schedule fires query failed", { orgId, err });
    return;
  }

  for (const workflowId of workflowIds) {
    const fires = firesByWorkflow.get(workflowId) ?? [];

    // Reuse the SAME aggregator the Inspector heatmap renders, so an alert
    // fires for exactly the slots the operator would see flagged in the panel.
    const heatmap = bucketScheduleFires(fires);
    const anomalies = heatmap.cells.filter((cell) => cell.anomaly);
    if (anomalies.length === 0) continue;

    await dispatchAlert({
      orgId,
      trigger: "workflow.schedule_anomaly",
      payload: {
        workflowId,
        windowDays: MAX_HISTORY_DAYS,
        anomalousSlotCount: anomalies.length,
        anomalousSlots: anomalies.slice(0, 10).map((cell) => ({
          dayOfWeek: cell.dayOfWeek,
          hour: cell.hour,
          total: cell.total,
          fail: cell.fail,
        })),
        totalFires: heatmap.totalFires,
        totalFail: heatmap.totalFail,
      },
    });
  }
}

export function collectScheduleAnomalyWorkflowTargets(
  policies: Pick<AlertPolicy, "parameters">[],
): { includeOtherScheduledWorkflows: boolean; priorityWorkflowIds: string[] } {
  let includeOtherScheduledWorkflows = false;
  const priorityWorkflowIds = new Set<string>();

  for (const policy of policies) {
    const workflowIds = (policy.parameters as Partial<AlertParamsByTrigger["workflow.schedule_anomaly"]>)
      .workflowIds;
    if (!Array.isArray(workflowIds) || workflowIds.length === 0) {
      includeOtherScheduledWorkflows = true;
      continue;
    }
    for (const workflowId of workflowIds) {
      if (typeof workflowId === "string" && workflowId.length > 0) {
        priorityWorkflowIds.add(workflowId);
      }
    }
  }

  if (priorityWorkflowIds.size > SCHEDULE_ANOMALY_MAX_WORKFLOWS) {
    console.warn("[alerts] schedule-anomaly workflow allowlist capped", {
      cap: SCHEDULE_ANOMALY_MAX_WORKFLOWS,
    });
  }

  return {
    includeOtherScheduledWorkflows,
    priorityWorkflowIds: [...priorityWorkflowIds].slice(0, SCHEDULE_ANOMALY_MAX_WORKFLOWS),
  };
}

/** Distinct workflow ids that have at least one ENABLED schedule entry for the
 *  org — the actively-scheduled set the anomaly scan walks. Explicit
 *  workflowIds filters are read first so a targeted policy cannot be hidden
 *  behind the general 200-workflow defensive cap. */
async function listScheduledWorkflowIds(
  orgId: string,
  target: { includeOtherScheduledWorkflows: boolean; priorityWorkflowIds: string[] },
): Promise<string[]> {
  const workflowIds = new Set<string>();

  if (target.priorityWorkflowIds.length > 0) {
    const priorityRows = await db
      .selectDistinct({ workflowId: scheduleEntries.workflowId })
      .from(scheduleEntries)
      .where(
        and(
          eq(scheduleEntries.orgId, orgId),
          eq(scheduleEntries.enabled, true),
          inArray(scheduleEntries.workflowId, target.priorityWorkflowIds),
        ),
      )
      .limit(SCHEDULE_ANOMALY_MAX_WORKFLOWS);
    for (const row of priorityRows) workflowIds.add(row.workflowId);
  }

  if (!target.includeOtherScheduledWorkflows) return [...workflowIds];

  const remaining = SCHEDULE_ANOMALY_MAX_WORKFLOWS - workflowIds.size;
  if (remaining <= 0) return [...workflowIds];

  const rows = await db
    .selectDistinct({ workflowId: scheduleEntries.workflowId })
    .from(scheduleEntries)
    .where(and(eq(scheduleEntries.orgId, orgId), eq(scheduleEntries.enabled, true)))
    .limit(remaining + 1);
  if (rows.length > remaining) {
    console.warn("[alerts] scheduled-workflow scan capped", {
      orgId,
      cap: SCHEDULE_ANOMALY_MAX_WORKFLOWS,
    });
  }
  for (const row of rows) {
    if (workflowIds.size >= SCHEDULE_ANOMALY_MAX_WORKFLOWS) break;
    workflowIds.add(row.workflowId);
  }
  return [...workflowIds];
}

// Re-export trigger type so the bootstrap file can reference it.
export type { AlertTrigger };

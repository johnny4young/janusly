/**
 * Periodic scanner for the three state-driven alert triggers:
 *   - `failure_cluster.threshold` — re-cluster recent failure samples and
 *     fire when a cluster's frequency crosses the policy's `minFrequency`.
 *   - `workflow.slo_breach` — re-evaluate SLO breaches per workflow with
 *     `slo_json IS NOT NULL`.
 *   - `approval.stalled` — find `run_nodes` waiting for human approval
 *     longer than `policy.parameters.stalledMinutes`.
 *
 * Event-driven triggers (`dlq.entry_created`, `budget.blocked`,
 * `limiter.degraded`) fire in-process via the DI seam and do NOT use this
 * scanner.
 *
 * Bootstrap behaviour:
 *   - Registered as a single deterministic BullMQ scheduler
 *     `system:alerts-scanner` running every 2 min by default
 *     (env-tunable via `JANUSLY_ALERTS_SCAN_CRON`).
 *   - Never throws — per-org failures are caught and console-warned so a
 *     single tenant's bad state can't stall the others.
 *   - Skips entirely when `JANUSLY_ALERTS_ENABLED !== "true"`.
 */

import { and, eq, sql } from "drizzle-orm";
import { db, runNodes, runs, workflowVersions } from "@janusly/db";

import {
  evaluateWorkflowSlo,
  type AlertTrigger,
  type AlertParamsByTrigger,
  type WorkflowSlo,
} from "@janusly/shared";
import { collectFailureSamples } from "@janusly/data/src/failureClusterRepo";
import { clusterFailureSamples } from "@janusly/engine/src/cluster-failures";
import { collectHealthSignals } from "@janusly/data/src/workflowHealthRepo";
import {
  getEnabledPoliciesByTrigger,
  listOrgIdsWithEnabledPolicies,
  type AlertPolicy,
} from "@janusly/data/src/alertPoliciesRepo";

import { dispatchAlert } from "@janusly/engine/src/alerts/dispatcher";

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

  for (const orgId of orgIds) {
    try {
      await runOrgScan(orgId);
    } catch (err) {
      console.error("[alerts] runOrgScan threw — should never happen", { orgId, err });
    }
  }
}

async function runOrgScan(orgId: string): Promise<void> {
  await scanFailureClusters(orgId);
  await scanWorkflowSloBreaches(orgId);
  await scanStalledApprovals(orgId);
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
    let samples: Awaited<ReturnType<typeof collectFailureSamples>>;
    try {
      samples = await collectFailureSamples(orgId, windowDays, FAILURE_SAMPLE_LIMIT);
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
    let signals: Awaited<ReturnType<typeof collectHealthSignals>>;
    try {
      signals = await collectHealthSignals(orgId, candidate.workflowId, candidate.slo.windowDays);
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

// Re-export trigger type so the bootstrap file can reference it.
export type { AlertTrigger };

/**
 * Controlled worker-interruption drill. It creates only the durable database
 * state a terminated worker leaves behind — a production-shaped run with one
 * old `running` node — then invokes the real stalled-node scan and atomic
 * terminal-failure boundary against that exact tenant/run.
 *
 * Used by `apps/api/src/routes/solution-packs-routes.ts` for fixtures whose
 * recovery path is `stalled_node_reaper`.
 *
 * Invariants:
 * - The scoped scan cannot reap unrelated production work.
 * - The configured production threshold is honored; the seeded `startedAt`
 *   is one second older than the computed boundary instead of bypassing it.
 * - No worker process is killed and no external node executor runs.
 * - The reaper, not this adapter, performs the running-node CAS, DLQ insert,
 *   node.failed event, and run failure.
 */

import { findStalledRunningNodes } from "@janusly/data";
import { db, runEvents, runNodes, runs } from "@janusly/db";
import type { Workflow } from "@janusly/shared";

import { safePersistPayload } from "../safe-persist";
import {
  reapStalledNodes,
  resolveStalledNodeThresholdMinutes,
} from "../stalled-node-reaper";
import { DeadLetterQueueAdapter } from "./dead-letter-queue";
import type { SampleFailureDrillSource } from "./sample-failure";

const DRILL_SCAN_LIMIT = 1;
const THRESHOLD_MARGIN_MS = 1_000;

/** Measured proof returned to the route and audit log. */
export type StalledNodeDrillEvidence = {
  recoveryPath: "stalled_node_reaper";
  thresholdMinutes: number;
  simulatedStallMs: number;
  reaperRuntimeMs: number;
  scanned: number;
  reaped: number;
  deadLettered: number;
};

export type RunStalledNodeDrillInput = {
  orgId: string;
  createdBy?: string | null;
  workflow: Workflow;
  failedNodeId: string;
  source: SampleFailureDrillSource & { recoveryPath: "stalled_node_reaper" };
  env?: NodeJS.ProcessEnv;
};

/**
 * Reproduce one stale worker claim and pass it through the production reaper.
 * Throws if the fixture is invalid or the scoped reaper cannot produce exactly
 * one replayable failure; callers surface that as a failed drill start.
 */
export async function runStalledNodeDrill(
  input: RunStalledNodeDrillInput,
): Promise<{ runId: string; deadLetterId: string; evidence: StalledNodeDrillEvidence }> {
  const failingNode = input.workflow.nodes.find((node) => node.id === input.failedNodeId);
  if (!failingNode) {
    throw new Error(`runStalledNodeDrill: node ${input.failedNodeId} not found in workflow`);
  }

  const thresholdMinutes = resolveStalledNodeThresholdMinutes(input.env ?? process.env);
  const thresholdMs = thresholdMinutes * 60_000;
  const initiatedAt = new Date();
  const simulatedStallMs = thresholdMs + THRESHOLD_MARGIN_MS;
  const stalledAt = new Date(initiatedAt.getTime() - simulatedStallMs);
  const runId = crypto.randomUUID();
  const workflowVersionId = runId;
  const drill = {
    ...input.source,
    initiatedAt: initiatedAt.toISOString(),
    simulatedStartedAt: stalledAt.toISOString(),
    thresholdMinutes,
  };

  await db.transaction(async (tx) => {
    await tx.insert(runs).values({
      id: runId,
      orgId: input.orgId,
      workflowVersionId,
      status: "running",
      createdBy: input.createdBy ?? null,
      inputJson: safePersistPayload({ workflow: input.workflow, input: {}, drill }),
      createdAt: stalledAt,
    });
    await tx.insert(runNodes).values({
      id: crypto.randomUUID(),
      runId,
      nodeId: input.failedNodeId,
      status: "running",
      attempts: 1,
      stateJson: safePersistPayload({}),
      startedAt: stalledAt,
    });
    await tx.insert(runEvents).values({
      id: crypto.randomUUID(),
      runId,
      nodeId: null,
      type: "run.started",
      payload: safePersistPayload({ workflowVersionId, drill: input.source }),
      createdAt: stalledAt,
    });
  });

  const adapter = new DeadLetterQueueAdapter();
  const reaperStartedAt = Date.now();
  const result = await reapStalledNodes(
    {
      findStalled: ({ olderThan, limit }) => findStalledRunningNodes({
        olderThan,
        limit,
        scope: { orgId: input.orgId, runId },
      }),
      persistFailure: (failure) => adapter.persistStalledTerminalFailure(failure),
      now: () => initiatedAt,
    },
    { thresholdMs, limit: DRILL_SCAN_LIMIT },
  );
  const deadLetterId = result.deadLetterIds[0];
  if (
    result.scanned !== 1
    || result.reaped !== 1
    || result.deadLettered !== 1
    || !deadLetterId
  ) {
    // The seed remains a legitimate stale row for the periodic production
    // sweep; never delete a possibly committed terminal result on ambiguity.
    throw new Error(
      `stalled-node drill did not complete: scanned=${result.scanned} `
      + `reaped=${result.reaped} deadLettered=${result.deadLettered}`,
    );
  }

  return {
    runId,
    deadLetterId,
    evidence: {
      recoveryPath: "stalled_node_reaper",
      thresholdMinutes,
      simulatedStallMs,
      reaperRuntimeMs: Math.max(0, Date.now() - reaperStartedAt),
      scanned: result.scanned,
      reaped: result.reaped,
      deadLettered: result.deadLettered,
    },
  };
}

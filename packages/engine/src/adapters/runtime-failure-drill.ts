/**
 * Safe runtime-backed recovery drill. It seeds only the successful ancestor
 * checkpoints needed to make one chosen node ready, then lets the normal
 * BullMQ worker execute that node through template resolution, retry policy,
 * the atomic terminal-failure boundary, and the production DLQ adapter.
 *
 * The selected node receives a stable missing-secret probe as the first config
 * field. Template resolution therefore fails before schema parsing, provider
 * calls, or external effects. The run remains `replayMode="validation"`, so
 * downstream write-side nodes would still be skipped if execution ever moved
 * beyond the probe.
 */

import { and, eq } from "drizzle-orm";

import { db, deadLetters, runEvents, runNodes, runs } from "@janusly/db";
import type { Workflow } from "@janusly/shared";

import { publishInitialNode } from "../initial-node-publication";
import { safePersistPayload } from "../safe-persist";
import type { SampleFailureDrillSource } from "./sample-failure";

const RUNTIME_DRILL_SECRET_NAME = "JANUSLY_RUNTIME_DRILL_MISSING_SECRET";
const RUNTIME_DRILL_PROBE_KEY = "runtimeDrillProbe";
const FAILURE_WAIT_TIMEOUT_MS = 30_000;
const FAILURE_POLL_INTERVAL_MS = 100;
const INITIAL_NODE_STATE_MAX_BYTES = 1_000_000;

type RuntimeFailureRow = {
  id: string;
  attempt: number;
};

export type RuntimeFailureDrillEvidence = {
  recoveryPath: "runtime_failure";
  boundary: "worker_dlq";
  executedNodeId: string;
  seededAncestorCount: number;
  attempts: number;
  runtimeMs: number;
};

export type RunRuntimeFailureDrillInput = {
  orgId: string;
  createdBy?: string | null;
  workflow: Workflow;
  failedNodeId: string;
  input?: unknown;
  source: SampleFailureDrillSource & { recoveryPath: "runtime_failure" };
};

type RuntimeFailureDrillDependencies = {
  publish?: typeof publishInitialNode;
  waitForFailure?: (input: {
    orgId: string;
    runId: string;
    nodeId: string;
  }) => Promise<RuntimeFailureRow>;
  now?: () => Date;
};

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function ancestorNodeIds(workflow: Workflow, targetNodeId: string): Set<string> {
  const predecessors = new Map<string, string[]>();
  for (const edge of workflow.edges) {
    const incoming = predecessors.get(edge.to) ?? [];
    incoming.push(edge.from);
    predecessors.set(edge.to, incoming);
  }

  const ancestors = new Set<string>();
  const pending = [...(predecessors.get(targetNodeId) ?? [])];
  while (pending.length > 0) {
    const nodeId = pending.pop()!;
    if (ancestors.has(nodeId)) continue;
    ancestors.add(nodeId);
    pending.push(...(predecessors.get(nodeId) ?? []));
  }
  return ancestors;
}

/** Clone a workflow and add the fail-before-effect probe to one node. */
export function prepareRuntimeFailureWorkflow(
  workflow: Workflow,
  failedNodeId: string,
): { workflow: Workflow; ancestorIds: Set<string> } {
  const failingNode = workflow.nodes.find((node) => node.id === failedNodeId);
  if (!failingNode) {
    throw new Error(`runRuntimeFailureDrill: node ${failedNodeId} not found in workflow`);
  }

  const prepared = structuredClone(workflow);
  prepared.nodes = prepared.nodes.map((node) => {
    if (node.id !== failedNodeId) return node;
    const originalConfig = { ...node.config };
    delete originalConfig[RUNTIME_DRILL_PROBE_KEY];
    return {
      ...node,
      config: {
        [RUNTIME_DRILL_PROBE_KEY]: `{{secret.${RUNTIME_DRILL_SECRET_NAME}}}`,
        ...originalConfig,
      },
    };
  });

  return { workflow: prepared, ancestorIds: ancestorNodeIds(prepared, failedNodeId) };
}

async function waitForRuntimeFailure(input: {
  orgId: string;
  runId: string;
  nodeId: string;
}): Promise<RuntimeFailureRow> {
  const deadline = Date.now() + FAILURE_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const [row] = await db
      .select({ id: deadLetters.id, attempt: deadLetters.attempt })
      .from(deadLetters)
      .where(and(
        eq(deadLetters.orgId, input.orgId),
        eq(deadLetters.runId, input.runId),
        eq(deadLetters.nodeId, input.nodeId),
      ))
      .limit(1);
    if (row) return row;
    await sleep(FAILURE_POLL_INTERVAL_MS);
  }
  throw new Error(`runtime failure drill timed out waiting for node ${input.nodeId}`);
}

/**
 * Execute one pack node through the real runtime failure boundary and wait for
 * the resulting DLQ identity so the API can focus the operator on that row.
 */
export async function runRuntimeFailureDrill(
  input: RunRuntimeFailureDrillInput,
  dependencies: RuntimeFailureDrillDependencies = {},
): Promise<{ runId: string; deadLetterId: string; evidence: RuntimeFailureDrillEvidence }> {
  if (process.env[RUNTIME_DRILL_SECRET_NAME] !== undefined) {
    throw new Error(`${RUNTIME_DRILL_SECRET_NAME} must remain unset for safe runtime drills`);
  }

  const { workflow, ancestorIds } = prepareRuntimeFailureWorkflow(
    input.workflow,
    input.failedNodeId,
  );
  const now = dependencies.now?.() ?? new Date();
  const runId = crypto.randomUUID();
  const workflowVersionId = runId;
  const rootNodeIds = new Set(
    workflow.nodes
      .filter((node) => !workflow.edges.some((edge) => edge.to === node.id))
      .map((node) => node.id),
  );

  await db.transaction(async (tx) => {
    await tx.insert(runs).values({
      id: runId,
      orgId: input.orgId,
      workflowVersionId,
      status: "running",
      replayMode: "validation",
      validationEvidenceLevel: "static",
      createdBy: input.createdBy ?? null,
      inputJson: {
        workflow,
        input: input.input ?? {},
        drill: input.source,
      },
      parentRunId: null,
      parentNodeId: null,
      traceId: null,
    });

    await tx.insert(runNodes).values(workflow.nodes.map((node) => {
      const isTarget = node.id === input.failedNodeId;
      const isAncestor = ancestorIds.has(node.id);
      const ancestorOutput = rootNodeIds.has(node.id) ? input.input ?? {} : {};
      return {
        id: crypto.randomUUID(),
        runId,
        nodeId: node.id,
        status: isTarget ? ("queued" as const) : isAncestor ? ("succeeded" as const) : ("pending" as const),
        stateJson: safePersistPayload(isAncestor ? { output: ancestorOutput } : {}, {
          maxBytes: INITIAL_NODE_STATE_MAX_BYTES,
        }),
        attempts: isTarget ? 1 : 0,
        queuePublicationRepairAfter: isTarget ? now : null,
        queuePublicationGeneration: isTarget ? 1 : 0,
        startedAt: isAncestor ? now : null,
        finishedAt: isAncestor ? now : null,
        errorJson: null,
      };
    }));

    await tx.insert(runEvents).values([
      {
        id: crypto.randomUUID(),
        runId,
        nodeId: null,
        type: "run.started.sandbox",
        payload: safePersistPayload({ workflowVersionId, source: input.source }),
      },
      ...Array.from(ancestorIds).map((nodeId) => ({
        id: crypto.randomUUID(),
        runId,
        nodeId,
        type: "node.completed",
        payload: safePersistPayload({ runtimeDrillSeeded: true }),
      })),
    ]);
  });

  const startedAt = Date.now();
  await (dependencies.publish ?? publishInitialNode)({
    runId,
    nodeId: input.failedNodeId,
    attempt: 1,
    publicationGeneration: 1,
  });
  const failure = await (dependencies.waitForFailure ?? waitForRuntimeFailure)({
    orgId: input.orgId,
    runId,
    nodeId: input.failedNodeId,
  });

  return {
    runId,
    deadLetterId: failure.id,
    evidence: {
      recoveryPath: "runtime_failure",
      boundary: "worker_dlq",
      executedNodeId: input.failedNodeId,
      seededAncestorCount: ancestorIds.size,
      attempts: failure.attempt,
      runtimeMs: Math.max(0, Date.now() - startedAt),
    },
  };
}

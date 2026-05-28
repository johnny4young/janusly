/**
 * `startRun` — bootstrap one run of a workflow.
 *
 * Wraps the `runs` insert + the batch `runNodes` insert + the `run.started`
 * event in a single Drizzle transaction. AGENTS.md invariant: don't split
 * this back into per-node inserts — the atomicity is what guarantees a
 * partially-started run never escapes to the queue.
 *
 * Used by:
 * - `apps/api/src/index.ts` `POST /start` — primary caller.
 * - `packages/engine/src/resume-run.ts` — for restart-from-checkpoint paths.
 *
 * Invariants:
 * - One transaction; all inserts succeed or none do.
 * - Distinct `run.started` vs `run.started.adhoc` audit events depending on
 *   whether the workflow was persisted. The split keeps audit
 *   readers honest about which runs came from saved DAGs.
 */

import { db, runs, runNodes, runEvents } from "@janusly/db";
import { enqueueNode } from "./queue";
import { markNodeQueued, appendEvent } from "./persistence";
import { safePersistPayload } from "./safe-persist";
import type { Workflow } from "@janusly/shared";
import { validateInputs, WorkflowInputValidationError } from "./inputs-validator";

const INITIAL_NODE_STATE_MAX_BYTES = 1_000_000;

export type StartableWorkflow = Workflow & {
  orgId?: string;
  createdBy?: string | null;
  input?: unknown;
  versionId?: string;
  /**
   * Subworkflow linkage. When present, this run was spawned by a
   * `subworkflow` node in the parent run. Used by `notifyParentOnTerminal`
   * to resume the parent's node when the child terminates.
   */
  parentRunId?: string;
  parentNodeId?: string;
  /** OTel trace id shared across a subworkflow chain. Inherited from the parent or generated lazily. */
  traceId?: string;
};

export async function startRun(workflow: StartableWorkflow) {
  // When the workflow declares typed `inputs`, validate the run-start payload
  // before any DB write so a malformed run never enters the queue. Throws
  // `WorkflowInputValidationError` — the API route catches and returns 400.
  if (workflow.inputs) {
    const result = validateInputs(workflow.inputs, workflow.input ?? {});
    if (!result.valid) throw new WorkflowInputValidationError(result.errors);
  }

  const runId = crypto.randomUUID();
  const workflowVersionId = workflow.versionId ?? workflow.id ?? runId;

  // Persist run + all nodes + the run.started event in one transaction so a
  // crash mid-setup cannot leave a partially-initialized run.
  await db.transaction(async (tx) => {
    await tx.insert(runs).values({
      id: runId,
      orgId: workflow.orgId ?? "default",
      workflowVersionId,
      status: "running",
      createdBy: workflow.createdBy ?? null,
      inputJson: { workflow, input: workflow.input ?? {} },
      parentRunId: workflow.parentRunId ?? null,
      parentNodeId: workflow.parentNodeId ?? null,
      traceId: workflow.traceId ?? null,
    });

    if (workflow.nodes.length > 0) {
      await tx.insert(runNodes).values(workflow.nodes.map((node) => ({
        id: crypto.randomUUID(),
        runId,
        nodeId: node.id,
        status: "pending",
        stateJson: safePersistPayload({}, { maxBytes: INITIAL_NODE_STATE_MAX_BYTES }),
      })));
    }

    await tx.insert(runEvents).values({
      id: crypto.randomUUID(),
      runId,
      nodeId: null,
      type: "run.started",
      payload: safePersistPayload({ workflowVersionId }),
    });
  });

  const startNodes = workflow.nodes.filter((node) => {
    return !workflow.edges.some((edge) => edge.to === node.id);
  });

  for (const node of startNodes) {
    await markNodeQueued(runId, node.id);
    await enqueueNode({ runId, workflow, node });
    await appendEvent(runId, node.id, "node.queued", {});
  }

  return { runId };
}

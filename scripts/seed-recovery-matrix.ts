/**
 * Idempotent dev seeder for the recovery-matrix smoke. Inserts one
 * workflow + one synthetic failing run + one DLQ row per fixture in
 * `apps/api/src/recovery-matrix-fixtures.ts`.
 *
 * Usage:
 *   pnpm seed:recovery-matrix
 *   pnpm seed:recovery-matrix -- --org=my-org-id
 *
 * Run while `pnpm dev` is up. Deletes prior seed rows before inserting,
 * so re-running gives a clean slate.
 */

import { eq, and, like } from "drizzle-orm";
import {
  db,
  workflows,
  workflowVersions,
  runs,
  runNodes,
  runEvents,
  deadLetters,
} from "@janusly/db";
import { RECOVERY_MATRIX_FIXTURES } from "../apps/api/src/recovery-matrix-fixtures";

function parseOrgId(): string {
  const arg = process.argv.find((a) => a.startsWith("--org="));
  return arg ? arg.slice("--org=".length) : "default";
}

const ORG_ID = parseOrgId();
const SEEDER_USER_ID = "recovery-matrix-seeder";
const ORG_SLUG = ORG_ID.replace(/[^a-zA-Z0-9_-]/g, "_");
const WORKFLOW_PREFIX = `recovery_matrix_${ORG_SLUG}_`;

async function reset() {
  // Order matters: child rows first so FK / orphan checks stay clean.
  await db.delete(runEvents).where(like(runEvents.runId, `${WORKFLOW_PREFIX}%`));
  await db.delete(runNodes).where(like(runNodes.runId, `${WORKFLOW_PREFIX}%`));
  await db.delete(deadLetters).where(and(eq(deadLetters.orgId, ORG_ID), like(deadLetters.runId, `${WORKFLOW_PREFIX}%`)));
  await db.delete(runs).where(and(eq(runs.orgId, ORG_ID), like(runs.id, `${WORKFLOW_PREFIX}%`)));
  await db.delete(workflowVersions).where(and(eq(workflowVersions.orgId, ORG_ID), like(workflowVersions.workflowId, `${WORKFLOW_PREFIX}%`)));
  await db.delete(workflows).where(and(eq(workflows.orgId, ORG_ID), like(workflows.id, `${WORKFLOW_PREFIX}%`)));
}

async function seed() {
  console.log(`[seed-recovery-matrix] org=${ORG_ID} clearing prior fixtures…`);
  await reset();

  let inserted = 0;
  for (const fixture of RECOVERY_MATRIX_FIXTURES) {
    const workflowId = `${WORKFLOW_PREFIX}${fixture.id}`;
    const versionId = `${workflowId}__v1`;
    const runId = `${workflowId}__run1`;
    const failingNode = fixture.workflow.nodes.find((node) => node.id === fixture.failedNodeId)!;

    // workflow + first version
    await db.insert(workflows).values({
      id: workflowId,
      orgId: ORG_ID,
      name: fixture.workflow.name ?? fixture.label,
      createdBy: SEEDER_USER_ID,
    });
    await db.insert(workflowVersions).values({
      id: versionId,
      orgId: ORG_ID,
      workflowId,
      version: 1,
      dagJson: { ...fixture.workflow, id: workflowId, name: fixture.workflow.name ?? fixture.label },
      createdBy: SEEDER_USER_ID,
    });

    // synthetic failed run + run_node + run_event
    await db.insert(runs).values({
      id: runId,
      orgId: ORG_ID,
      workflowVersionId: versionId,
      status: "failed",
      inputJson: {},
    });
    await db.insert(runNodes).values({
      id: `${runId}__${fixture.failedNodeId}`,
      runId,
      nodeId: fixture.failedNodeId,
      status: "failed",
      attempts: 1,
      stateJson: {},
      errorJson: fixture.errorJson,
    });
    await db.insert(runEvents).values({
      id: `${runId}__node.failed`,
      runId,
      nodeId: fixture.failedNodeId,
      type: "node.failed",
      payload: { error: fixture.errorJson },
    });

    // DLQ entry — what the recovery dialog reads when the operator clicks Suggest fix.
    const deadLetterId = `${workflowId}__dlq1`;
    await db.insert(deadLetters).values({
      id: deadLetterId,
      orgId: ORG_ID,
      runId,
      nodeId: fixture.failedNodeId,
      attempt: 3,
      workflowJson: { ...fixture.workflow, id: workflowId, name: fixture.workflow.name ?? fixture.label },
      nodeJson: failingNode,
      errorJson: fixture.errorJson,
      status: "open",
    });

    inserted += 1;
    console.log(`[seed-recovery-matrix] ✓ ${fixture.id.padEnd(32)} dlq=${deadLetterId}  expectedTopApproachLabel=${fixture.expectedTopApproachLabel}`);
  }

  console.log(`[seed-recovery-matrix] done — ${inserted} fixtures seeded for org=${ORG_ID}.`);
  console.log(`\nDrive the smoke from the web UI:`);
  console.log(`  1. Open DeadLettersPanel.`);
  console.log(`  2. For each row labelled "Recovery Matrix · …" click "Suggest fix" → "Generate suggestion".`);
  console.log(`  3. Record: mode, suggestions.length, (approachLabel, confidence) per tab.`);
  console.log(`  4. Validate the audit row: SELECT action, metadata FROM audit_logs WHERE action='ai.workflow.patch_suggested' ORDER BY id DESC LIMIT ${RECOVERY_MATRIX_FIXTURES.length};`);
}

seed()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[seed-recovery-matrix] failed:", error);
    process.exit(1);
  });

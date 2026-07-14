/** Real-Postgres proof for Recovery Playbook versioning and outcome CAS. */

import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import {
  auditLogs,
  db,
  deadLetters,
  recoveryImpactEvents,
  recoveryImpactRollups,
  recoveryPlaybooks,
  runs,
  workflowVersions,
  workflows,
} from "@janusly/db";
import { recordRecoveryImpactTx } from "../recoveryMetricsRepo";
import {
  activateRecoveryPlaybook,
  createRecoveryPlaybookDraft,
  findMatchingActiveRecoveryPlaybook,
  getRecoveryPlaybook,
  recordRecoveryPlaybookApplied,
  recordRecoveryPlaybookValidationOutcome,
} from "../recoveryPlaybooksRepo";

const RUN_TAG = `${Date.now()}-${process.pid}`;
const ORG = `it-playbooks-${RUN_TAG}`;
const OTHER_ORG = `it-playbooks-other-${RUN_TAG}`;
const WORKFLOW = `workflow-${RUN_TAG}`;
const SIGNATURE = "http:timeout:billing-api";

const workflow = {
  id: WORKFLOW,
  name: "Billing recovery",
  dslVersion: "1.0",
  nodes: [{ id: "fetch", type: "http", config: { url: "https://example.com", method: "GET", timeoutMs: 5000 } }],
  edges: [],
};

afterAll(async () => {
  await db.delete(recoveryImpactEvents).where(eq(recoveryImpactEvents.orgId, ORG));
  await db.delete(recoveryImpactRollups).where(eq(recoveryImpactRollups.orgId, ORG));
  await db.delete(auditLogs).where(eq(auditLogs.orgId, ORG));
  await db.delete(deadLetters).where(eq(deadLetters.orgId, ORG));
  await db.delete(recoveryPlaybooks).where(eq(recoveryPlaybooks.orgId, ORG));
  await db.delete(runs).where(eq(runs.orgId, ORG));
  await db.delete(workflowVersions).where(eq(workflowVersions.orgId, ORG));
  await db.delete(workflows).where(eq(workflows.orgId, ORG));
});

describe("Recovery Playbooks (real Postgres)", () => {
  it("versions drafts, manually activates one match, and records outcomes once", async () => {
    await db.insert(workflows).values({ id: WORKFLOW, orgId: ORG, name: workflow.name, createdBy: "operator" });
    await db.insert(workflowVersions).values([
      { id: `wv-1-${RUN_TAG}`, orgId: ORG, workflowId: WORKFLOW, version: 1, dagJson: workflow, createdBy: "operator" },
      { id: `wv-2-${RUN_TAG}`, orgId: ORG, workflowId: WORKFLOW, version: 2, dagJson: workflow, createdBy: "operator" },
    ]);

    const first = await createRecoveryPlaybookDraft({
      orgId: ORG,
      workflowId: WORKFLOW,
      signature: SIGNATURE,
      title: "Retry billing",
      instructionsMarkdown: "Validate and apply the bounded retry.",
      evidenceRequirementsJson: { token: "must-redact", requiredOnEveryUse: ["sandbox_validation"] },
      sourceWorkflowVersionId: `wv-1-${RUN_TAG}`,
      approachLabel: "add_retry",
      validationRunId: `validation-source-1-${RUN_TAG}`,
      actor: "operator",
    });
    const duplicate = await createRecoveryPlaybookDraft({
      orgId: ORG,
      workflowId: WORKFLOW,
      signature: SIGNATURE,
      title: "Duplicate request",
      instructionsMarkdown: "Should return the first row.",
      evidenceRequirementsJson: {},
      sourceWorkflowVersionId: `wv-1-${RUN_TAG}`,
      approachLabel: "add_retry",
      validationRunId: `validation-source-1-${RUN_TAG}`,
      actor: "operator",
    });
    const second = await createRecoveryPlaybookDraft({
      orgId: ORG,
      workflowId: WORKFLOW,
      signature: SIGNATURE,
      title: "Retry billing v2",
      instructionsMarkdown: "Revalidate the current dependency first.",
      evidenceRequirementsJson: { requiredOnEveryUse: ["sandbox_validation", "explicit_production_apply"] },
      sourceWorkflowVersionId: `wv-2-${RUN_TAG}`,
      approachLabel: "raise_timeout",
      validationRunId: `validation-source-2-${RUN_TAG}`,
      actor: "operator",
    });

    expect(first.playbook.version).toBe(1);
    expect(duplicate).toMatchObject({ created: false, playbook: { id: first.playbook.id } });
    expect(second.playbook.version).toBe(2);
    expect((first.playbook.evidenceRequirementsJson as { token?: unknown }).token).toBe("[redacted]");

    expect((await activateRecoveryPlaybook(ORG, first.playbook.id, "operator")).kind).toBe("ok");
    expect((await activateRecoveryPlaybook(ORG, second.playbook.id, "operator")).kind).toBe("ok");
    expect((await getRecoveryPlaybook(ORG, first.playbook.id))?.status).toBe("retired");
    expect(await getRecoveryPlaybook(OTHER_ORG, second.playbook.id)).toBeNull();

    const matched = await findMatchingActiveRecoveryPlaybook(ORG, WORKFLOW, SIGNATURE);
    expect(matched).toMatchObject({ id: second.playbook.id, status: "active", sourceWorkflow: workflow });

    const validationRunId = `validation-use-${RUN_TAG}`;
    const secondValidationRunId = `validation-use-2-${RUN_TAG}`;
    const regressionRunId = `validation-regression-${RUN_TAG}`;
    await db.insert(runs).values([
      { id: validationRunId, orgId: ORG, workflowVersionId: `wv-2-${RUN_TAG}`, status: "succeeded", replayMode: "validation" },
      { id: secondValidationRunId, orgId: ORG, workflowVersionId: `wv-2-${RUN_TAG}`, status: "succeeded", replayMode: "validation" },
      { id: regressionRunId, orgId: ORG, workflowVersionId: `wv-2-${RUN_TAG}`, status: "failed", replayMode: "validation" },
    ]);
    const validated = await recordRecoveryPlaybookValidationOutcome({
      orgId: ORG, id: second.playbook.id, validationRunId, succeeded: true, actor: "operator",
    });
    const duplicateValidation = await recordRecoveryPlaybookValidationOutcome({
      orgId: ORG, id: second.playbook.id, validationRunId, succeeded: true, actor: "operator",
    });
    expect(validated.recorded).toBe(true);
    expect(duplicateValidation.recorded).toBe(false);

    const secondValidation = await recordRecoveryPlaybookValidationOutcome({
      orgId: ORG, id: second.playbook.id, validationRunId: secondValidationRunId, succeeded: true, actor: "operator",
    });
    const outOfOrderDuplicateValidation = await recordRecoveryPlaybookValidationOutcome({
      orgId: ORG, id: second.playbook.id, validationRunId, succeeded: true, actor: "operator",
    });
    expect(secondValidation.recorded).toBe(true);
    expect(outOfOrderDuplicateValidation.recorded).toBe(false);

    const applied = await recordRecoveryPlaybookApplied({
      orgId: ORG, id: second.playbook.id, validationRunId, actor: "operator",
    });
    const duplicateApply = await recordRecoveryPlaybookApplied({
      orgId: ORG, id: second.playbook.id, validationRunId, actor: "operator",
    });
    expect(applied.playbook?.successfulUses).toBe(1);
    expect(duplicateApply).toMatchObject({ recorded: false, playbook: { successfulUses: 1 } });

    const secondApply = await recordRecoveryPlaybookApplied({
      orgId: ORG, id: second.playbook.id, validationRunId: secondValidationRunId, actor: "operator",
    });
    const outOfOrderDuplicateApply = await recordRecoveryPlaybookApplied({
      orgId: ORG, id: second.playbook.id, validationRunId, actor: "operator",
    });
    expect(secondApply.playbook?.successfulUses).toBe(2);
    expect(outOfOrderDuplicateApply).toMatchObject({ recorded: false, playbook: { successfulUses: 2 } });

    const regression = await recordRecoveryPlaybookValidationOutcome({
      orgId: ORG,
      id: second.playbook.id,
      validationRunId: regressionRunId,
      succeeded: false,
      actor: "operator",
    });
    expect(regression.playbook).toMatchObject({ status: "retired", regressions: 1, successfulUses: 2 });
    expect(await findMatchingActiveRecoveryPlaybook(ORG, WORKFLOW, SIGNATURE)).toBeNull();
  });

  it("credits one successful use only when terminal recovery impact commits", async () => {
    const workflowId = `${WORKFLOW}-terminal`;
    const versionId = `wv-terminal-${RUN_TAG}`;
    const validationRunId = `validation-terminal-${RUN_TAG}`;
    const deadLetterId = `dlq-terminal-${RUN_TAG}`;
    const productionRunId = `production-terminal-${RUN_TAG}`;
    const nodeId = `fetch-terminal-${RUN_TAG}`;
    const recoveredAt = new Date();
    const terminalWorkflow = { ...workflow, id: workflowId };

    await db.insert(workflows).values({
      id: workflowId,
      orgId: ORG,
      name: terminalWorkflow.name,
      createdBy: "operator",
    });
    await db.insert(workflowVersions).values({
      id: versionId,
      orgId: ORG,
      workflowId,
      version: 1,
      dagJson: terminalWorkflow,
      createdBy: "operator",
    });
    const draft = await createRecoveryPlaybookDraft({
      orgId: ORG,
      workflowId,
      signature: `${SIGNATURE}:terminal`,
      title: "Terminally verified retry",
      instructionsMarkdown: "Count this use only after production succeeds.",
      evidenceRequirementsJson: { requiredOnEveryUse: ["sandbox_validation"] },
      sourceWorkflowVersionId: versionId,
      approachLabel: "add_retry",
      validationRunId,
      actor: "operator",
    });
    expect((await activateRecoveryPlaybook(ORG, draft.playbook.id, "operator")).kind).toBe("ok");

    await db.insert(runs).values({
      id: validationRunId,
      orgId: ORG,
      workflowVersionId: versionId,
      status: "succeeded",
      replayMode: "validation",
    });
    await db.insert(deadLetters).values({
      id: deadLetterId,
      orgId: ORG,
      runId: productionRunId,
      nodeId,
      status: "replayed",
      replayClaimedAt: new Date(recoveredAt.getTime() - 1_000),
      replayedAt: new Date(recoveredAt.getTime() - 500),
      createdAt: new Date(recoveredAt.getTime() - 60_000),
      workflowJson: terminalWorkflow,
      nodeJson: { id: nodeId, type: "http", config: {} },
      errorJson: { message: "fixture failure" },
    });

    await expect(db.transaction((tx) => recordRecoveryImpactTx(tx, {
      deadLetterId,
      userId: "operator",
      playbookId: draft.playbook.id,
      validationRunId,
      runId: productionRunId,
      nodeId,
      recoveredAt,
    }))).resolves.toBe(true);
    await expect(db.transaction((tx) => recordRecoveryImpactTx(tx, {
      deadLetterId,
      userId: "operator",
      playbookId: draft.playbook.id,
      validationRunId,
      runId: productionRunId,
      nodeId,
      recoveredAt: new Date(recoveredAt.getTime() + 1_000),
    }))).resolves.toBe(false);

    expect(await getRecoveryPlaybook(ORG, draft.playbook.id)).toMatchObject({
      successfulUses: 1,
      lastAppliedValidationRunId: validationRunId,
    });
    const [validationRun] = await db.select({
      appliedAt: runs.recoveryPlaybookAppliedRecordedAt,
    }).from(runs).where(and(eq(runs.orgId, ORG), eq(runs.id, validationRunId))).limit(1);
    expect(validationRun?.appliedAt).toEqual(recoveredAt);
    const appliedAudits = await db.select({ id: auditLogs.id }).from(auditLogs).where(and(
      eq(auditLogs.orgId, ORG),
      eq(auditLogs.action, "recovery.playbook.applied"),
      eq(auditLogs.targetId, draft.playbook.id),
    ));
    expect(appliedAudits).toHaveLength(1);
  });
});

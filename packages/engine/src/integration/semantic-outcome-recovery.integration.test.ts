/**
 * Real-Postgres proof for the semantic-outcome transaction boundary:
 * node success, business-outcome posture, durable cases, containment
 * receipts, and timeline evidence commit together. Concurrent quarantines
 * keep the run blocked until every source has an operator decision.
 */

import { and, eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import {
  db,
  deadLetters,
  recoveryCases,
  recoveryCaseTransitions,
  recoveryImpactEvents,
  recoveryImpactRollups,
  runEvents,
  runNodes,
  runs,
} from "@janusly/db";
import {
  markNodeSucceededWithOutcome,
  resolveSemanticOutcomeCase,
} from "../persistence";

const STAMP = `${Date.now()}-${process.pid}`;
const ORG_ID = `semantic-recovery-${STAMP}`;
const RUN_ID = `semantic-run-${STAMP}`;
const ACCEPT_RUN_ID = `semantic-accept-${STAMP}`;
const RACE_RUN_ID = `semantic-race-${STAMP}`;
const IMPACT_RUN_ID = `semantic-impact-${STAMP}`;
const CONTEXT_RUN_ID = `semantic-context-${STAMP}`;
const IMPACT_DLQ_ID = `semantic-impact-dlq-${STAMP}`;
const TEST_RUN_IDS = [
  RUN_ID,
  ACCEPT_RUN_ID,
  RACE_RUN_ID,
  IMPACT_RUN_ID,
  CONTEXT_RUN_ID,
];

const workflow = {
  dslVersion: "1.0" as const,
  id: "semantic-workflow",
  nodes: [
    { id: "answer", type: "noop" as const, config: {} },
    { id: "secondary", type: "noop" as const, config: {} },
    { id: "notify", type: "noop" as const, config: {} },
  ],
  edges: [
    { from: "answer", to: "notify" },
    { from: "secondary", to: "notify" },
  ],
  recovery: {
    contract: {
      version: "2" as const,
      failure: {
        technical: {
          terminalNodeFailure: true as const,
          stalledNode: true,
        },
        semantic: {
          mode: "deterministic" as const,
          detectors: [
            {
              id: "ai-mode",
              sourceNodeId: "answer",
              kind: "expression" as const,
              passWhen: 'context.answer.output.mode === "ai"',
              action: "quarantine" as const,
              message: "AI output is required",
            },
            {
              id: "answer-shape",
              sourceNodeId: "answer",
              kind: "schema" as const,
              schema: {
                type: "object" as const,
                required: ["text"],
                properties: {
                  text: { type: "string" as const },
                },
              },
              action: "observe" as const,
              message: "Answer text is required",
            },
            {
              id: "secondary-mode",
              sourceNodeId: "secondary",
              kind: "expression" as const,
              passWhen:
                'context.secondary.output.mode === "ai"',
              action: "quarantine" as const,
              message: "Secondary output is required",
            },
          ],
          evaluationFixtures: [
            {
              id: "answer-pass",
              sourceNodeId: "answer",
              output: { mode: "ai", text: "ready" },
              expected: "pass" as const,
            },
            {
              id: "answer-fail",
              sourceNodeId: "answer",
              output: { mode: "fallback" },
              expected: "violation" as const,
            },
            {
              id: "secondary-pass",
              sourceNodeId: "secondary",
              output: { mode: "ai" },
              expected: "pass" as const,
            },
            {
              id: "secondary-fail",
              sourceNodeId: "secondary",
              output: { mode: "fallback" },
              expected: "violation" as const,
            },
          ],
        },
      },
      evidence: {
        required: [
          "failure_snapshot" as const,
          "audit_trail" as const,
          "terminal_outcome" as const,
        ],
      },
      effects: [],
      repairs: { allowed: ["retry" as const] },
      validation: { minimumEvidenceLevel: "static" as const },
      approval: {
        productionMutation: "required" as const,
        permission: "recovery.write" as const,
      },
      autonomyLevel: 3 as const,
      verification: {
        kind: "generation_bound_terminal_success" as const,
      },
      recurrence: { windowDays: 7 },
    },
  },
};

const crossContextWorkflow = {
  ...workflow,
  id: "semantic-cross-context-workflow",
  nodes: [
    { id: "reference", type: "noop" as const, config: {} },
    { id: "answer", type: "noop" as const, config: {} },
  ],
  edges: [{ from: "reference", to: "answer" }],
  recovery: {
    contract: {
      ...workflow.recovery.contract,
      failure: {
        ...workflow.recovery.contract.failure,
        semantic: {
          mode: "deterministic" as const,
          detectors: [{
            id: "current-reference",
            sourceNodeId: "answer",
            kind: "expression" as const,
            passWhen:
              'context.answer.output.mode === "ai" && context.reference.output.revision === "v2"',
            action: "quarantine" as const,
            message: "The answer must match the current reference",
          }],
          evaluationFixtures: [
            {
              id: "current-reference-pass",
              sourceNodeId: "answer",
              output: { mode: "ai" },
              context: {
                reference: { output: { revision: "v2" } },
              },
              expected: "pass" as const,
            },
            {
              id: "current-reference-fail",
              sourceNodeId: "answer",
              output: { mode: "ai" },
              context: {
                reference: { output: { revision: "v1" } },
              },
              expected: "violation" as const,
            },
          ],
        },
      },
    },
  },
};

afterAll(async () => {
  const cases = await db
    .select({ id: recoveryCases.id })
    .from(recoveryCases)
    .where(eq(recoveryCases.orgId, ORG_ID));
  for (const item of cases) {
    await db
      .delete(recoveryCaseTransitions)
      .where(eq(recoveryCaseTransitions.caseId, item.id));
  }
  await db
    .delete(recoveryCases)
    .where(eq(recoveryCases.orgId, ORG_ID));
  await db
    .delete(runEvents)
    .where(inArray(runEvents.runId, TEST_RUN_IDS));
  await db
    .delete(runNodes)
    .where(inArray(runNodes.runId, TEST_RUN_IDS));
  await db
    .delete(recoveryImpactEvents)
    .where(eq(recoveryImpactEvents.orgId, ORG_ID));
  await db
    .delete(recoveryImpactRollups)
    .where(eq(recoveryImpactRollups.orgId, ORG_ID));
  await db
    .delete(deadLetters)
    .where(eq(deadLetters.orgId, ORG_ID));
  await db
    .delete(runs)
    .where(
      and(
        inArray(runs.id, TEST_RUN_IDS),
        eq(runs.orgId, ORG_ID),
      ),
    );
});

describe("semantic outcome recovery transaction (real Postgres)", () => {
  it("holds concurrent quarantines and resumes only after the final valid replacement", async () => {
    await db.insert(runs).values({
      id: RUN_ID,
      orgId: ORG_ID,
      workflowVersionId: `${RUN_ID}-version`,
      status: "running",
      createdBy: "operator-1",
      inputJson: { workflow, input: {} },
    });
    await db.insert(runNodes).values([
      {
        id: `${RUN_ID}-answer`,
        runId: RUN_ID,
        nodeId: "answer",
        status: "running",
        attempts: 1,
      },
      {
        id: `${RUN_ID}-secondary`,
        runId: RUN_ID,
        nodeId: "secondary",
        status: "running",
        attempts: 1,
      },
      {
        id: `${RUN_ID}-notify`,
        runId: RUN_ID,
        nodeId: "notify",
        status: "pending",
        attempts: 0,
      },
    ]);

    const answerCompletion = await markNodeSucceededWithOutcome(
      RUN_ID,
      "answer",
      { mode: "fallback" },
      1,
      [
        {
          detectorId: "ai-mode",
          sourceNodeId: "answer",
          kind: "expression",
          action: "quarantine",
          message: "AI output is required",
        },
        {
          detectorId: "answer-shape",
          sourceNodeId: "answer",
          kind: "schema",
          action: "observe",
          message: "Answer text is required",
        },
      ],
    );
    expect(answerCompletion).toMatchObject({
      completed: true,
      quarantined: true,
      caseIds: [
        expect.stringMatching(/^sem_/),
        expect.stringMatching(/^sem_/),
      ],
    });

    const secondaryCompletion =
      await markNodeSucceededWithOutcome(
        RUN_ID,
        "secondary",
        { mode: "fallback" },
        1,
        [{
          detectorId: "secondary-mode",
          sourceNodeId: "secondary",
          kind: "expression",
          action: "quarantine",
          message: "Secondary output is required",
        }],
      );
    expect(secondaryCompletion).toMatchObject({
      completed: true,
      quarantined: true,
    });

    const [run] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, RUN_ID));
    expect(run).toMatchObject({
      status: "waiting",
      outcomeStatus: "semantic_quarantined",
      semanticViolationCount: 3,
    });

    const cases = await db
      .select()
      .from(recoveryCases)
      .where(eq(recoveryCases.runId, RUN_ID));
    const answerCase = cases.find(
      (item) => item.detectorId === "ai-mode",
    )!;
    const observedCase = cases.find(
      (item) => item.detectorId === "answer-shape",
    )!;
    const secondaryCase = cases.find(
      (item) => item.detectorId === "secondary-mode",
    )!;
    expect(answerCase).toMatchObject({
      state: "contained",
      action: "quarantine",
    });
    expect(observedCase).toMatchObject({
      state: "detected",
      action: "observe",
    });
    expect(secondaryCase).toMatchObject({
      state: "contained",
      action: "quarantine",
    });

    const rejected = await resolveSemanticOutcomeCase({
      orgId: ORG_ID,
      caseId: answerCase.id,
      actorId: "operator-1",
      decision: "replace",
      output: { mode: "fallback" },
      reason: "Try a replacement",
    });
    expect(rejected).toMatchObject({
      status: "invalid_output",
      violations: [
        expect.objectContaining({ detectorId: "ai-mode" }),
        expect.objectContaining({ detectorId: "answer-shape" }),
      ],
    });

    const answerResolution = await resolveSemanticOutcomeCase({
      orgId: ORG_ID,
      caseId: answerCase.id,
      actorId: "operator-1",
      decision: "replace",
      output: { mode: "ai", text: "Reviewed answer" },
      reason: "Use the reviewed replacement",
    });
    expect(answerResolution).toMatchObject({
      status: "resolved",
      resumed: false,
      resolvedCaseIds: expect.arrayContaining([
        answerCase.id,
        observedCase.id,
      ]),
    });

    const [stillQuarantinedRun] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, RUN_ID));
    expect(stillQuarantinedRun).toMatchObject({
      status: "waiting",
      outcomeStatus: "semantic_quarantined",
    });
    const [answerNode] = await db
      .select({ stateJson: runNodes.stateJson })
      .from(runNodes)
      .where(
        and(
          eq(runNodes.runId, RUN_ID),
          eq(runNodes.nodeId, "answer"),
        ),
      );
    expect(answerNode?.stateJson).toEqual({
      output: { mode: "ai", text: "Reviewed answer" },
    });
    const answerCases = await db
      .select()
      .from(recoveryCases)
      .where(
        inArray(recoveryCases.id, [
          answerCase.id,
          observedCase.id,
        ]),
      );
    expect(answerCases).toHaveLength(2);
    expect(
      answerCases.every(
        (item) => item.state === "verified_recovered",
      ),
    ).toBe(true);

    const finalResolution = await resolveSemanticOutcomeCase({
      orgId: ORG_ID,
      caseId: secondaryCase.id,
      actorId: "operator-1",
      decision: "replace",
      output: { mode: "ai" },
      reason: "Use the reviewed secondary output",
    });
    expect(finalResolution).toMatchObject({
      status: "resolved",
      resumed: true,
      resolvedCaseIds: [secondaryCase.id],
    });

    const [recoveredRun] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, RUN_ID));
    expect(recoveredRun).toMatchObject({
      status: "running",
      outcomeStatus: "semantic_recovered",
    });
    const [notifyNode] = await db
      .select({
        queuePublicationRepairAfter:
          runNodes.queuePublicationRepairAfter,
      })
      .from(runNodes)
      .where(
        and(
          eq(runNodes.runId, RUN_ID),
          eq(runNodes.nodeId, "notify"),
        ),
      );
    expect(notifyNode?.queuePublicationRepairAfter).toBeInstanceOf(
      Date,
    );

    for (const item of [answerCase, observedCase, secondaryCase]) {
      const transitions = await db
        .select()
        .from(recoveryCaseTransitions)
        .where(eq(recoveryCaseTransitions.caseId, item.id));
      expect(transitions).toHaveLength(8);
      expect(transitions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fromState: "monitoring",
            toState: "verified_recovered",
          }),
        ]),
      );
    }
  });

  it("records the actual source state when mixed violations are accepted", async () => {
    await db.insert(runs).values({
      id: ACCEPT_RUN_ID,
      orgId: ORG_ID,
      workflowVersionId: `${ACCEPT_RUN_ID}-version`,
      status: "running",
      createdBy: "operator-1",
      inputJson: { workflow, input: {} },
    });
    await db.insert(runNodes).values({
      id: `${ACCEPT_RUN_ID}-answer`,
      runId: ACCEPT_RUN_ID,
      nodeId: "answer",
      status: "running",
      attempts: 1,
    });

    const completion = await markNodeSucceededWithOutcome(
      ACCEPT_RUN_ID,
      "answer",
      { mode: "fallback" },
      1,
      [
        {
          detectorId: "ai-mode",
          sourceNodeId: "answer",
          kind: "expression",
          action: "quarantine",
          message: "AI output is required",
        },
        {
          detectorId: "answer-shape",
          sourceNodeId: "answer",
          kind: "schema",
          action: "observe",
          message: "Answer text is required",
        },
      ],
    );
    expect(completion).toMatchObject({
      completed: true,
      quarantined: true,
    });

    const cases = await db
      .select()
      .from(recoveryCases)
      .where(eq(recoveryCases.runId, ACCEPT_RUN_ID));
    const quarantineCase = cases.find(
      (item) => item.action === "quarantine",
    )!;
    const observedCase = cases.find(
      (item) => item.action === "observe",
    )!;

    const resolution = await resolveSemanticOutcomeCase({
      orgId: ORG_ID,
      caseId: quarantineCase.id,
      actorId: "operator-1",
      decision: "accept_loss",
      reason: "The degraded output is acceptable for this execution",
    });
    expect(resolution).toMatchObject({
      status: "resolved",
      resumed: true,
      resolvedCaseIds: expect.arrayContaining([
        quarantineCase.id,
        observedCase.id,
      ]),
    });

    const receipts = await db
      .select()
      .from(recoveryCaseTransitions)
      .where(
        inArray(recoveryCaseTransitions.caseId, [
          quarantineCase.id,
          observedCase.id,
        ]),
      );
    expect(receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          caseId: quarantineCase.id,
          fromState: "contained",
          toState: "accepted_loss",
        }),
        expect.objectContaining({
          caseId: observedCase.id,
          fromState: "detected",
          toState: "accepted_loss",
        }),
      ]),
    );
  });

  it("credits a replay only after a quarantined output is replaced and verified", async () => {
    await db.insert(runs).values({
      id: IMPACT_RUN_ID,
      orgId: ORG_ID,
      workflowVersionId: `${IMPACT_RUN_ID}-version`,
      status: "running",
      createdBy: "operator-1",
      inputJson: { workflow, input: {} },
    });
    await db.insert(deadLetters).values({
      id: IMPACT_DLQ_ID,
      orgId: ORG_ID,
      runId: IMPACT_RUN_ID,
      nodeId: "answer",
      workflowJson: workflow,
      nodeJson: {
        id: "answer",
        type: "noop",
        config: {},
      },
      errorJson: { message: "Original answer failed" },
      createdAt: new Date(Date.now() - 30_000),
    });
    await db.insert(runNodes).values({
      id: `${IMPACT_RUN_ID}-answer`,
      runId: IMPACT_RUN_ID,
      nodeId: "answer",
      status: "running",
      attempts: 1,
      recoveryDeadLetterId: IMPACT_DLQ_ID,
      recoveryRequestedBy: "operator-1",
      recoveryClaimToken: "semantic-impact-claim",
    });

    const completion = await markNodeSucceededWithOutcome(
      IMPACT_RUN_ID,
      "answer",
      { mode: "fallback" },
      1,
      [{
        detectorId: "ai-mode",
        sourceNodeId: "answer",
        kind: "expression",
        action: "quarantine",
        message: "AI output is required",
      }],
      "semantic-impact-claim",
    );
    expect(completion).toMatchObject({
      completed: true,
      quarantined: true,
    });
    expect(
      await db
        .select()
        .from(recoveryImpactEvents)
        .where(eq(recoveryImpactEvents.deadLetterId, IMPACT_DLQ_ID)),
    ).toHaveLength(0);

    const [recoveryCase] = await db
      .select()
      .from(recoveryCases)
      .where(
        and(
          eq(recoveryCases.runId, IMPACT_RUN_ID),
          eq(recoveryCases.detectorId, "ai-mode"),
        ),
      );
    const resolution = await resolveSemanticOutcomeCase({
      orgId: ORG_ID,
      caseId: recoveryCase!.id,
      actorId: "operator-1",
      decision: "replace",
      output: { mode: "ai", text: "Verified replacement" },
      reason: "The replacement satisfies the business contract",
    });
    expect(resolution).toMatchObject({
      status: "resolved",
      resumed: true,
    });

    const impact = await db
      .select()
      .from(recoveryImpactEvents)
      .where(
        eq(recoveryImpactEvents.deadLetterId, IMPACT_DLQ_ID),
      );
    expect(impact).toHaveLength(1);
    const [deadLetter] = await db
      .select({ status: deadLetters.status })
      .from(deadLetters)
      .where(eq(deadLetters.id, IMPACT_DLQ_ID));
    expect(deadLetter?.status).toBe("replayed");
  });

  it("validates replacements against the locked cross-node context", async () => {
    await db.insert(runs).values({
      id: CONTEXT_RUN_ID,
      orgId: ORG_ID,
      workflowVersionId: `${CONTEXT_RUN_ID}-version`,
      status: "running",
      createdBy: "operator-1",
      inputJson: { workflow: crossContextWorkflow, input: {} },
    });
    await db.insert(runNodes).values([
      {
        id: `${CONTEXT_RUN_ID}-reference`,
        runId: CONTEXT_RUN_ID,
        nodeId: "reference",
        status: "succeeded",
        attempts: 1,
        stateJson: { output: { revision: "v1" } },
      },
      {
        id: `${CONTEXT_RUN_ID}-answer`,
        runId: CONTEXT_RUN_ID,
        nodeId: "answer",
        status: "running",
        attempts: 1,
      },
    ]);
    await markNodeSucceededWithOutcome(
      CONTEXT_RUN_ID,
      "answer",
      { mode: "fallback" },
      1,
      [{
        detectorId: "current-reference",
        sourceNodeId: "answer",
        kind: "expression",
        action: "quarantine",
        message: "The answer must match the current reference",
      }],
    );
    const [recoveryCase] = await db
      .select()
      .from(recoveryCases)
      .where(eq(recoveryCases.runId, CONTEXT_RUN_ID));

    let signalUpdateReady!: () => void;
    const updateReady = new Promise<void>((resolve) => {
      signalUpdateReady = resolve;
    });
    let releaseUpdate!: () => void;
    const updateReleased = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    const updateTransaction = db.transaction(async (tx) => {
      await tx
        .update(runNodes)
        .set({ stateJson: { output: { revision: "v2" } } })
        .where(
          and(
            eq(runNodes.runId, CONTEXT_RUN_ID),
            eq(runNodes.nodeId, "reference"),
          ),
        );
      signalUpdateReady();
      await updateReleased;
    });
    await updateReady;

    let resolutionSettled = false;
    const resolutionPromise = resolveSemanticOutcomeCase({
      orgId: ORG_ID,
      caseId: recoveryCase!.id,
      actorId: "operator-1",
      decision: "replace",
      output: { mode: "ai" },
      reason: "Use the replacement against the current reference",
    }).finally(() => {
      resolutionSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const waitedForLockedContext = !resolutionSettled;
    releaseUpdate();
    await updateTransaction;
    const resolution = await resolutionPromise;

    expect(waitedForLockedContext).toBe(true);
    expect(resolution).toMatchObject({
      status: "resolved",
      resumed: true,
    });
  });

  it("keeps quarantine posture when concurrent observe-only evidence lands last", async () => {
    await db.insert(runs).values({
      id: RACE_RUN_ID,
      orgId: ORG_ID,
      workflowVersionId: `${RACE_RUN_ID}-version`,
      status: "running",
      createdBy: "operator-1",
      inputJson: { workflow, input: {} },
    });
    await db.insert(runNodes).values([
      {
        id: `${RACE_RUN_ID}-quarantine`,
        runId: RACE_RUN_ID,
        nodeId: "quarantine",
        status: "running",
        attempts: 1,
      },
      {
        id: `${RACE_RUN_ID}-observe`,
        runId: RACE_RUN_ID,
        nodeId: "observe",
        status: "running",
        attempts: 1,
      },
    ]);

    await Promise.all([
      markNodeSucceededWithOutcome(
        RACE_RUN_ID,
        "quarantine",
        { accepted: false },
        1,
        [{
          detectorId: "quarantine-detector",
          sourceNodeId: "quarantine",
          kind: "expression",
          action: "quarantine",
          message: "The result requires operator review",
        }],
      ),
      markNodeSucceededWithOutcome(
        RACE_RUN_ID,
        "observe",
        { quality: "degraded" },
        1,
        [{
          detectorId: "observe-detector",
          sourceNodeId: "observe",
          kind: "expression",
          action: "observe",
          message: "The result quality is degraded",
        }],
      ),
    ]);

    const [run] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, RACE_RUN_ID));
    expect(run).toMatchObject({
      status: "waiting",
      outcomeStatus: "semantic_quarantined",
      semanticViolationCount: 2,
    });
  });
});

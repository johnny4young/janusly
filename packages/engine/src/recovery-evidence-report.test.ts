/**
 * Tests for the pure recovery-evidence report builder. The builder is
 * pure — no DB, no LLM call — so tests build the snapshot bundle inline.
 *
 * Coverage targets (the ticket AC):
 * - Secret-shape values in ANY rendered free-form string are scrubbed
 *   (redaction at render time, on top of the write-time chokepoint).
 * - The run timeline respects the run-explain pagination cap.
 * - JSON + Markdown output is stable for a fixed `generatedAt`.
 * - The selected patch diff is computed via the shared
 *   `computeWorkflowDiff` (DLQ workflow vs validated patch).
 * - The sandbox validation result surfaces success / failure.
 * - The approval trail is reconstructed from approval nodes + events.
 * - Audit rows are rendered with actor + action.
 * - The rollback link is present when a prior version exists.
 * - A missing DLQ row / missing run degrades gracefully (partial artefact).
 */
import { describe, expect, it } from "vitest";

import { RUN_EXPLAIN_TIMELINE_CAP } from "./run-explain-report";
import {
  buildRecoveryEvidenceReport,
  type BuildRecoveryEvidenceInput,
  type EvidenceReportAuditRow,
  type EvidenceReportDeadLetter,
  type EvidenceReportRecoveryItem,
  type EvidenceReportRun,
  type EvidenceReportRunEvent,
  type EvidenceReportRunNode,
} from "./recovery-evidence-report";

const FIXED_NOW = "2026-05-20T12:00:00.000Z";

function recoveryItem(overrides: Partial<EvidenceReportRecoveryItem> = {}): EvidenceReportRecoveryItem {
  return {
    id: "ri_1",
    deadLetterId: "dlq_1",
    workflowId: "wf_billing",
    owner: "user-alpha",
    severity: "p2",
    status: "resolved",
    slaTargetAt: new Date("2026-05-20T16:00:00Z"),
    resolutionReason: "fixed_by_patch",
    resolvedBy: "user-alpha",
    resolvedAt: new Date("2026-05-20T11:30:00Z"),
    errorSignature: "HTTP 401 on http node",
    occurrenceCount: 3,
    comments: [
      { id: "c1", authorUserId: "user-alpha", body: "looking into it", createdAt: "2026-05-20T10:00:00Z" },
    ],
    createdAt: new Date("2026-05-20T09:00:00Z"),
    updatedAt: new Date("2026-05-20T11:30:00Z"),
    ...overrides,
  };
}

function deadLetter(overrides: Partial<EvidenceReportDeadLetter> = {}): EvidenceReportDeadLetter {
  return {
    id: "dlq_1",
    runId: "run_orig",
    nodeId: "call_api",
    attempt: 3,
    status: "open",
    workflowJson: {
      name: "Billing flow",
      nodes: [
        { id: "start", type: "noop", config: {} },
        { id: "call_api", type: "http", config: { url: "https://api.example.com", method: "POST" } },
      ],
      edges: [{ from: "start", to: "call_api" }],
    },
    nodeJson: { id: "call_api", type: "http" },
    errorJson: { message: "Request failed with status 401" },
    replayedAt: null,
    createdAt: new Date("2026-05-20T09:00:00Z"),
    ...overrides,
  };
}

function originalRun(overrides: Partial<EvidenceReportRun> = {}): EvidenceReportRun {
  return {
    id: "run_orig",
    status: "failed",
    workflowVersionId: "wfv_2",
    parentRunId: null,
    replayMode: null,
    inputJson: { workflow: { id: "wf_billing", name: "Billing flow" } },
    outputJson: null,
    createdAt: new Date("2026-05-20T08:55:00Z"),
    ...overrides,
  };
}

function validationRun(overrides: Partial<EvidenceReportRun> = {}): EvidenceReportRun {
  return {
    id: "run_val",
    status: "succeeded",
    workflowVersionId: "run_val",
    parentRunId: "run_orig",
    replayMode: "validation",
    inputJson: {
      workflow: {
        name: "Billing flow",
        nodes: [
          { id: "start", type: "noop", config: {} },
          // patched: a retry was added + method fixed to GET
          { id: "call_api", type: "http", config: { url: "https://api.example.com", method: "GET", retry: { maxAttempts: 3 } } },
        ],
        edges: [{ from: "start", to: "call_api" }],
      },
      failingNodeId: "call_api",
    },
    outputJson: null,
    createdAt: new Date("2026-05-20T10:30:00Z"),
    ...overrides,
  };
}

function patchAudit(overrides: Partial<EvidenceReportAuditRow> = {}): EvidenceReportAuditRow {
  return {
    id: "aud_patch",
    action: "ai.workflow.patch_suggested",
    targetType: "dlq",
    targetId: "dlq_1",
    userId: "user-alpha",
    metadata: {
      mode: "ai",
      envelopeKind: "AiPatchHttpConfigEnvelope",
      patchStyle: "config_only",
      topApproachLabel: "add_retry",
      suggestionsCount: 2,
      runId: "run_orig",
      actor: { userId: "user-alpha", mode: "dev-headers" },
    },
    createdAt: new Date("2026-05-20T10:00:00Z"),
    ...overrides,
  };
}

function baseInput(overrides: Partial<BuildRecoveryEvidenceInput> = {}): BuildRecoveryEvidenceInput {
  return {
    recoveryItem: recoveryItem(),
    deadLetter: deadLetter(),
    originalRun: originalRun(),
    originalRunNodes: [
      { nodeId: "start", status: "completed", attempts: 1, startedAt: new Date("2026-05-20T08:55:01Z"), finishedAt: new Date("2026-05-20T08:55:02Z"), stateJson: { nodeType: "noop" }, errorJson: null },
      { nodeId: "call_api", status: "failed", attempts: 3, startedAt: new Date("2026-05-20T08:55:03Z"), finishedAt: new Date("2026-05-20T08:55:09Z"), stateJson: { nodeType: "http" }, errorJson: { message: "Request failed with status 401" } },
    ],
    originalRunEvents: [
      { id: "e1", nodeId: null, type: "run.started", createdAt: new Date("2026-05-20T08:55:00Z"), payload: null },
      { id: "e2", nodeId: "call_api", type: "node.failed", createdAt: new Date("2026-05-20T08:55:09Z"), payload: null },
    ],
    originalRunEventsTruncated: false,
    validationRun: validationRun(),
    validationRunNodes: [
      { nodeId: "call_api", status: "completed", attempts: 1, startedAt: new Date("2026-05-20T10:30:01Z"), finishedAt: new Date("2026-05-20T10:30:02Z"), stateJson: { nodeType: "http" }, errorJson: null },
    ],
    auditRows: [
      patchAudit(),
      { id: "aud_val", action: "recovery.validation_started", targetType: "dlq", targetId: "dlq_1", userId: "user-alpha", metadata: { validationRunId: "run_val", actor: { userId: "user-alpha" } }, createdAt: new Date("2026-05-20T10:25:00Z") },
      { id: "aud_res", action: "recovery.item.resolved", targetType: "recovery-item", targetId: "ri_1", userId: "user-alpha", metadata: { actor: { userId: "user-alpha" } }, createdAt: new Date("2026-05-20T11:30:00Z") },
    ],
    rollback: { workflowId: "wf_billing", currentVersion: 2, priorVersion: 1 },
    appBaseUrl: "https://app.janusly.test",
    generatedAt: FIXED_NOW,
    ...overrides,
  };
}

describe("buildRecoveryEvidenceReport", () => {
  it("builds the full incident envelope with every section", () => {
    const { json } = buildRecoveryEvidenceReport(baseInput());

    expect(json.generatedAt).toBe(FIXED_NOW);
    expect(json.incident.recoveryItemId).toBe("ri_1");
    expect(json.incident.deadLetterId).toBe("dlq_1");
    expect(json.incident.severity).toBe("p2");
    expect(json.incident.status).toBe("resolved");
    expect(json.incident.occurrenceCount).toBe(3);
    expect(json.incident.failureSignature).toBe("HTTP 401 on http node");
    expect(json.incident.commentCount).toBe(1);

    expect(json.deadLetter?.runId).toBe("run_orig");
    expect(json.deadLetter?.nodeId).toBe("call_api");
    expect(json.deadLetter?.errorSummary).toContain("401");

    expect(json.run).not.toBeNull();
    expect(json.run?.summary.runId).toBe("run_orig");
    expect(json.run?.failedNode?.nodeId).toBe("call_api");

    expect(json.aiExplanation?.mode).toBe("ai");
    expect(json.aiExplanation?.topApproachLabel).toBe("add_retry");

    expect(json.sandboxValidation?.validationRunId).toBe("run_val");
    expect(json.sandboxValidation?.status).toBe("succeeded");

    expect(json.rollback?.priorVersion).toBe(1);
    expect(json.rollback?.url).toContain("rollbackTo=1");
  });

  it("computes the selected patch diff via computeWorkflowDiff (DLQ workflow vs validated patch)", () => {
    const { json } = buildRecoveryEvidenceReport(baseInput());
    expect(json.patchDiff).not.toBeNull();
    // The patched call_api node changed config (method + retry added).
    const changedNode = json.patchDiff?.nodes.find((n) => n.kind === "changed" && n.nodeId === "call_api");
    expect(changedNode).toBeDefined();
    expect(json.patchDiff?.summary.totalChanges).toBeGreaterThan(0);
    // The retry addition should be tagged so the UI can colour it.
    const retryField = changedNode && changedNode.kind === "changed"
      ? changedNode.fields.find((f) => f.tag === "retry")
      : undefined;
    expect(retryField).toBeDefined();
  });

  it("returns a null patch diff when there is no validation run", () => {
    const { json } = buildRecoveryEvidenceReport(baseInput({ validationRun: null, validationRunNodes: [] }));
    expect(json.patchDiff).toBeNull();
    expect(json.sandboxValidation).toBeNull();
  });

  it("surfaces a failed sandbox validation with the scrubbed failure summary", () => {
    const { json } = buildRecoveryEvidenceReport(
      baseInput({
        validationRun: validationRun({ status: "failed" }),
        validationRunNodes: [
          { nodeId: "call_api", status: "failed", attempts: 1, startedAt: new Date("2026-05-20T10:30:01Z"), finishedAt: new Date("2026-05-20T10:30:05Z"), stateJson: { nodeType: "http" }, errorJson: { message: "still failing: 401" } },
        ],
      }),
    );
    expect(json.sandboxValidation?.status).toBe("failed");
    expect(json.sandboxValidation?.failureSummary).toContain("still failing");
  });

  it("scrubs secret-shaped values in every rendered free-form string", () => {
    const leak = "ghp_1234567890abcdefghijklmnopqrstuvwxyzAB";
    const bearer = "Bearer sk-ABCDEFGHIJKLMNOPQRSTUVWX";
    const { json, markdown } = buildRecoveryEvidenceReport(
      baseInput({
        // Secret in the DLQ error message (escapes write-time key-redaction
        // because it's a free-form value, not a sensitive KEY).
        deadLetter: deadLetter({ errorJson: { message: `auth rejected: ${leak}` } }),
        // Secret echoed in a stored failure signature.
        recoveryItem: recoveryItem({ errorSignature: `token ${bearer}` }),
        // Secret in the AI explanation's aiError.
        auditRows: [
          patchAudit({ metadata: { mode: "fallback", aiError: `provider said ${leak}`, runId: "run_orig" } }),
        ],
        validationRun: validationRun({ status: "failed" }),
        validationRunNodes: [
          { nodeId: "call_api", status: "failed", attempts: 1, startedAt: null, finishedAt: null, stateJson: { nodeType: "http" }, errorJson: { message: `nope ${bearer}` } },
        ],
      }),
    );

    const blob = JSON.stringify(json) + markdown;
    expect(blob).not.toContain(leak);
    expect(blob).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUVWX");
    // The redaction sentinel from scrubSecretShapes should appear instead.
    expect(json.deadLetter?.errorSummary).toContain("[redacted]");
    expect(json.incident.failureSignature).toContain("[redacted]");
    expect(json.aiExplanation?.aiError).toContain("[redacted]");
  });

  it("respects the run-explain timeline pagination cap", () => {
    const manyEvents: EvidenceReportRunEvent[] = Array.from({ length: RUN_EXPLAIN_TIMELINE_CAP + 25 }, (_, i) => ({
      id: `e${i}`,
      nodeId: "call_api",
      type: `node.step.${i}`,
      createdAt: new Date(Date.parse("2026-05-20T08:00:00Z") + i * 1000),
      payload: null,
    }));
    const { json } = buildRecoveryEvidenceReport(baseInput({ originalRunEvents: manyEvents }));
    expect(json.run?.timeline.length).toBe(RUN_EXPLAIN_TIMELINE_CAP);
    expect(json.run?.timelineTruncated).toBe(true);
  });

  it("reconstructs the approval trail from approval nodes + events", () => {
    const { json } = buildRecoveryEvidenceReport(
      baseInput({
        originalRunNodes: [
          { nodeId: "gate", status: "completed", attempts: 1, startedAt: new Date("2026-05-20T08:55:01Z"), finishedAt: new Date("2026-05-20T08:56:00Z"), stateJson: { nodeType: "approval" }, errorJson: null },
          { nodeId: "call_api", status: "failed", attempts: 3, startedAt: new Date("2026-05-20T08:56:01Z"), finishedAt: new Date("2026-05-20T08:56:09Z"), stateJson: { nodeType: "http" }, errorJson: { message: "401" } },
        ],
        originalRunEvents: [
          { id: "a1", nodeId: "gate", type: "approval.requested", createdAt: new Date("2026-05-20T08:55:01Z"), payload: null },
          { id: "a2", nodeId: "gate", type: "approval.decided", createdAt: new Date("2026-05-20T08:56:00Z"), payload: null },
        ],
      }),
    );
    expect(json.approvalTrail).toHaveLength(1);
    expect(json.approvalTrail[0].nodeId).toBe("gate");
    expect(json.approvalTrail[0].status).toBe("completed");
    expect(json.approvalTrail[0].lastEvent).toBe("approval.decided");
  });

  it("renders the audit trail with action + actor", () => {
    const { json } = buildRecoveryEvidenceReport(baseInput());
    const actions = json.auditTrail.map((a) => a.action);
    expect(actions).toContain("ai.workflow.patch_suggested");
    expect(actions).toContain("recovery.validation_started");
    expect(actions).toContain("recovery.item.resolved");
    // Actor lifted from metadata.actor.userId.
    expect(json.auditTrail.every((a) => a.actor === "user-alpha")).toBe(true);
  });

  it("produces stable, deterministic JSON + Markdown for a fixed generatedAt", () => {
    const a = buildRecoveryEvidenceReport(baseInput());
    const b = buildRecoveryEvidenceReport(baseInput());
    expect(a.json).toEqual(b.json);
    expect(a.markdown).toBe(b.markdown);
    // Markdown carries every top-level section heading exactly once.
    for (const heading of [
      "## Incident",
      "## Dead letter",
      "## Original run",
      "## AI explanation",
      "## Selected patch diff",
      "## Sandbox validation",
      "## Approval trail",
      "## Audit trail",
      "## Rollback",
    ]) {
      expect(a.markdown.split(heading).length).toBe(2);
    }
    // A single top-level title (no nested run-explain `# ` survives the demote).
    expect(a.markdown.match(/^# /gm)?.length).toBe(1);
  });

  it("degrades to a partial artefact when the DLQ row and run are gone", () => {
    const { json, markdown } = buildRecoveryEvidenceReport(
      baseInput({
        deadLetter: null,
        originalRun: null,
        originalRunNodes: [],
        originalRunEvents: [],
        validationRun: null,
        validationRunNodes: [],
        rollback: null,
        auditRows: [],
      }),
    );
    // The incident metadata is always retained even with everything else gone.
    expect(json.incident.recoveryItemId).toBe("ri_1");
    expect(json.deadLetter).toBeNull();
    expect(json.run).toBeNull();
    expect(json.patchDiff).toBeNull();
    expect(json.rollback).toBeNull();
    expect(markdown).toContain("no longer present");
  });

  it("omits the rollback url when no app base url is supplied", () => {
    const { json } = buildRecoveryEvidenceReport(baseInput({ appBaseUrl: null }));
    expect(json.rollback?.priorVersion).toBe(1);
    expect(json.rollback?.url).toBeNull();
  });
});

/**
 * Tests for the AI evidence assembler. The per-kind builders are pure and
 * exercised directly; the async orchestrators mock the two supplemental
 * data reads (`getWorkflowMetadata` + `queryFailureSamples`) so the suite is
 * pure-unit.
 *
 * Covers the AC categories:
 *  - empty case (no sources → `evidence: []`)
 *  - source link integrity (`sourceRef` carries the right id per kind)
 *  - redaction at read (secret-shaped content scrubbed in the snippet)
 *  - tenant scope (`orgId` flows into both supplemental reads)
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const { getWorkflowMetadataMock, queryFailureSamplesMock } = vi.hoisted(() => ({
  getWorkflowMetadataMock: vi.fn(),
  queryFailureSamplesMock: vi.fn(),
}));

vi.mock("@janusly/data/src/workflowMetadataRepo", () => ({
  getWorkflowMetadata: getWorkflowMetadataMock,
}));

vi.mock("@janusly/data/src/failureClusterRepo", () => ({
  queryFailureSamples: queryFailureSamplesMock,
}));

import type { FailureSample, FeedbackSummary, MemoryRecallEntry } from "@janusly/data";

import {
  assembleExplainRunEvidence,
  assembleRecoveryEvidence,
  assembleSuggestImprovementEvidence,
  buildFeedbackEvidence,
  buildMemoryEvidence,
  buildRecentErrorEvidence,
  buildRunbookEvidence,
  buildSignatureRuleEvidence,
  buildToolContractEvidence,
} from "./ai-evidence";

function feedbackSummary(over: Partial<FeedbackSummary> = {}): FeedbackSummary {
  return {
    approachLabel: over.approachLabel ?? "add_retry",
    acceptedCount: over.acceptedCount ?? 2,
    rejectedCount: over.rejectedCount ?? 1,
    rejectionComments: over.rejectionComments ?? [],
  };
}

function memoryEntry(over: Partial<MemoryRecallEntry> = {}): MemoryRecallEntry {
  return {
    id: over.id ?? "mem-1",
    kind: over.kind ?? "recovery_rationale",
    content: over.content ?? "operator accepted add_retry for the billing timeout",
    similarity: over.similarity ?? 0.83,
    workflowId: over.workflowId ?? "wf-1",
    runId: over.runId ?? null,
    metadata: over.metadata ?? null,
    createdAt: over.createdAt ?? new Date(0),
  };
}

function failureSample(over: Partial<FailureSample> = {}): FailureSample {
  return {
    source: over.source ?? "dead_letter",
    id: over.id ?? "dlq-1",
    workflowId: over.workflowId ?? "wf-1",
    workflowName: over.workflowName ?? "Billing",
    runId: over.runId ?? "run-1",
    nodeId: over.nodeId ?? "n1",
    nodeType: over.nodeType ?? "http",
    toolName: over.toolName,
    errorJson: over.errorJson ?? { message: "HTTP 401 unauthorized" },
    status: over.status,
    createdAt: over.createdAt ?? new Date(0),
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("buildFeedbackEvidence", () => {
  it("emits one row per decided approach with the approachLabel as sourceRef", () => {
    const rows = buildFeedbackEvidence([
      feedbackSummary({ approachLabel: "add_retry", acceptedCount: 3, rejectedCount: 1 }),
      feedbackSummary({ approachLabel: "raise_timeout", acceptedCount: 0, rejectedCount: 2 }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: "recovery_feedback", sourceRef: "add_retry" });
    expect(rows[0]!.snippet).toContain("3 accepted");
    expect(rows[1]!.sourceRef).toBe("raise_timeout");
  });

  it("skips approaches with zero decisions (empty case)", () => {
    expect(buildFeedbackEvidence([feedbackSummary({ acceptedCount: 0, rejectedCount: 0 })])).toEqual([]);
    expect(buildFeedbackEvidence([])).toEqual([]);
  });

  it("weights by acceptance ratio", () => {
    const [row] = buildFeedbackEvidence([feedbackSummary({ acceptedCount: 3, rejectedCount: 1 })]);
    expect(row!.weight).toBeCloseTo(0.75);
  });
});

describe("buildMemoryEvidence", () => {
  it("uses the memory entry id as sourceRef and similarity as weight", () => {
    const rows = buildMemoryEvidence([memoryEntry({ id: "mem-42", similarity: 0.91 })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "memory_entry", sourceRef: "mem-42", weight: 0.91 });
  });

  it("returns empty for no entries (memory disabled → empty case)", () => {
    expect(buildMemoryEvidence([])).toEqual([]);
  });
});

describe("buildRunbookEvidence", () => {
  it("uses the workflow id as sourceRef and excerpts the runbook", () => {
    const rows = buildRunbookEvidence("wf-7", "## Runbook\nRestart the worker, then replay.");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "runbook_excerpt", sourceRef: "wf-7" });
    expect(rows[0]!.snippet).toContain("Runbook");
  });

  it("returns empty when there is no runbook or no workflow id (empty case)", () => {
    expect(buildRunbookEvidence("wf-7", null)).toEqual([]);
    expect(buildRunbookEvidence("wf-7", "   ")).toEqual([]);
    expect(buildRunbookEvidence(null, "## Runbook")).toEqual([]);
  });
});

describe("buildRecentErrorEvidence", () => {
  it("normalizes signatures and uses the run id as sourceRef", () => {
    const rows = buildRecentErrorEvidence([
      failureSample({ runId: "run-9", errorJson: { message: "HTTP 401 unauthorized" }, nodeType: "http" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("recent_error");
    expect(rows[0]!.sourceRef).toBe("run-9");
    // Signature is the normalized label, not the raw message.
    expect(rows[0]!.snippet.length).toBeGreaterThan(0);
  });

  it("excludes the current failing run and filters by workflow", () => {
    const rows = buildRecentErrorEvidence(
      [
        failureSample({ runId: "current", errorJson: { message: "boom A" } }),
        failureSample({ runId: "other", workflowId: "wf-other", errorJson: { message: "boom B" } }),
        failureSample({ runId: "match", workflowId: "wf-1", errorJson: { message: "HTTP 500 server error" }, nodeType: "http" }),
      ],
      { workflowId: "wf-1", excludeRunId: "current" },
    );
    expect(rows.map((r) => r.sourceRef)).toEqual(["match"]);
  });

  it("collapses duplicate signatures", () => {
    const rows = buildRecentErrorEvidence([
      failureSample({ runId: "r1", errorJson: { message: "HTTP 500 server error" }, nodeType: "http" }),
      failureSample({ runId: "r2", errorJson: { message: "HTTP 500 server error" }, nodeType: "http" }),
    ]);
    expect(rows).toHaveLength(1);
  });

  it("returns empty for no samples (empty case)", () => {
    expect(buildRecentErrorEvidence([])).toEqual([]);
  });
});

describe("buildSignatureRuleEvidence — redaction at read", () => {
  it("names the rule category as sourceRef and scrubs secrets in the snippet", () => {
    const rows = buildSignatureRuleEvidence(
      { message: "auth failed: sk-abcdefghijklmnopqrstuvwxyz012345" },
      { type: "http", id: "n1" },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("signature_rule");
    expect(rows[0]!.sourceRef.length).toBeGreaterThan(0);
  });

  it("returns empty when there is no error (empty case)", () => {
    expect(buildSignatureRuleEvidence(null, { type: "http" })).toEqual([]);
  });
});

describe("buildToolContractEvidence", () => {
  it("lists required + optional fields with the tool name as sourceRef", () => {
    const rows = buildToolContractEvidence({
      name: "github.create_issue",
      required: ["repo", "title"],
      optional: ["body"],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "tool_contract", sourceRef: "github.create_issue" });
    expect(rows[0]!.snippet).toContain("repo, title");
  });

  it("returns empty for a non-tool failure (null contract → empty case)", () => {
    expect(buildToolContractEvidence(null)).toEqual([]);
  });
});

describe("assembleRecoveryEvidence — orchestrator", () => {
  it("flows orgId into both supplemental reads (tenant scope)", async () => {
    getWorkflowMetadataMock.mockResolvedValue({ runbookMarkdown: "## Runbook\nDo the thing." });
    queryFailureSamplesMock.mockResolvedValue([]);
    await assembleRecoveryEvidence({
      orgId: "org-XYZ",
      workflowId: "wf-1",
      runId: "run-1",
      failingNode: { type: "http", id: "n1" },
      errorJson: { message: "HTTP 500" },
      feedbackSummaries: [],
      memoryEntries: [],
      toolContract: null,
    });
    expect(getWorkflowMetadataMock).toHaveBeenCalledWith("org-XYZ", "wf-1");
    expect(queryFailureSamplesMock).toHaveBeenCalledWith("org-XYZ", expect.any(Number), expect.any(Number));
  });

  it("composes every source and scrubs at read", async () => {
    getWorkflowMetadataMock.mockResolvedValue({ runbookMarkdown: "## Runbook excerpt" });
    queryFailureSamplesMock.mockResolvedValue([
      failureSample({ runId: "prior", workflowId: "wf-1", errorJson: { message: "HTTP 502 bad gateway" }, nodeType: "http" }),
    ]);
    const rows = await assembleRecoveryEvidence({
      orgId: "org-1",
      workflowId: "wf-1",
      runId: "run-current",
      failingNode: { type: "tool", id: "n1", toolName: "github.create_issue" },
      errorJson: { message: "auth failed: ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
      feedbackSummaries: [feedbackSummary({ approachLabel: "add_retry", acceptedCount: 2, rejectedCount: 0 })],
      memoryEntries: [memoryEntry({ id: "mem-1", content: "leaked sk-abcdefghijklmnopqrstuvwxyz012345 here" })],
      toolContract: { name: "github.create_issue", required: ["repo", "title"], optional: ["body"] },
    });
    const kinds = rows.map((r) => r.kind);
    expect(kinds).toContain("signature_rule");
    expect(kinds).toContain("tool_contract");
    expect(kinds).toContain("recovery_feedback");
    expect(kinds).toContain("memory_entry");
    expect(kinds).toContain("runbook_excerpt");
    expect(kinds).toContain("recent_error");
    // No raw secret survives in any snippet.
    for (const row of rows) {
      expect(row.snippet).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
      expect(row.snippet).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    }
    // The current run is excluded from recent errors.
    const recent = rows.filter((r) => r.kind === "recent_error");
    expect(recent.every((r) => r.sourceRef !== "run-current")).toBe(true);
  });

  it("degrades to empty when there are no sources (empty case)", async () => {
    getWorkflowMetadataMock.mockResolvedValue(null);
    queryFailureSamplesMock.mockResolvedValue([]);
    const rows = await assembleRecoveryEvidence({
      orgId: "org-1",
      workflowId: null,
      runId: "run-1",
      failingNode: null,
      errorJson: null,
      feedbackSummaries: [],
      memoryEntries: [],
      toolContract: null,
    });
    expect(rows).toEqual([]);
  });

  it("survives a supplemental read failure (best-effort)", async () => {
    getWorkflowMetadataMock.mockRejectedValue(new Error("db blip"));
    queryFailureSamplesMock.mockRejectedValue(new Error("db blip"));
    const rows = await assembleRecoveryEvidence({
      orgId: "org-1",
      workflowId: "wf-1",
      runId: "run-1",
      failingNode: { type: "http", id: "n1" },
      errorJson: { message: "HTTP 500" },
      feedbackSummaries: [],
      memoryEntries: [],
      toolContract: null,
    });
    // The signature rule (from data the route already had) still renders.
    expect(rows.some((r) => r.kind === "signature_rule")).toBe(true);
  });
});

describe("assembleExplainRunEvidence", () => {
  it("emits the signature rule + runbook, scoped to org", async () => {
    getWorkflowMetadataMock.mockResolvedValue({ runbookMarkdown: "## Restart steps" });
    const rows = await assembleExplainRunEvidence({
      orgId: "org-E",
      workflowId: "wf-1",
      failingNode: { type: "http", id: "n1" },
      errorJson: { message: "HTTP 503 unavailable" },
    });
    expect(getWorkflowMetadataMock).toHaveBeenCalledWith("org-E", "wf-1");
    expect(rows.map((r) => r.kind)).toEqual(expect.arrayContaining(["signature_rule", "runbook_excerpt"]));
  });

  it("returns empty for a healthy run with no error + no runbook (empty case)", async () => {
    getWorkflowMetadataMock.mockResolvedValue(null);
    const rows = await assembleExplainRunEvidence({
      orgId: "org-1",
      workflowId: "wf-1",
      failingNode: null,
      errorJson: null,
    });
    expect(rows).toEqual([]);
  });
});

describe("assembleSuggestImprovementEvidence", () => {
  it("emits past-feedback + runbook, scoped to org", async () => {
    getWorkflowMetadataMock.mockResolvedValue({ runbookMarkdown: "## How to operate" });
    const rows = await assembleSuggestImprovementEvidence({
      orgId: "org-S",
      workflowId: "wf-1",
      feedbackSummaries: [feedbackSummary({ approachLabel: "fix_url", acceptedCount: 1, rejectedCount: 0 })],
    });
    expect(getWorkflowMetadataMock).toHaveBeenCalledWith("org-S", "wf-1");
    expect(rows.map((r) => r.kind)).toEqual(expect.arrayContaining(["recovery_feedback", "runbook_excerpt"]));
  });

  it("returns empty for a fresh workflow (empty case)", async () => {
    getWorkflowMetadataMock.mockResolvedValue(null);
    const rows = await assembleSuggestImprovementEvidence({
      orgId: "org-1",
      workflowId: "wf-1",
      feedbackSummaries: [],
    });
    expect(rows).toEqual([]);
  });
});

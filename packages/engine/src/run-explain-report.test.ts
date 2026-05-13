/**
 * Tests for the pure run-explain report builder. The builder is pure —
 * no DB, no LLM call — so tests build snapshots inline.
 *
 * Coverage targets:
 * - Clean succeeded run renders no Root cause / Failed node sections.
 * - Failed run with errorJson renders root cause + failed node + next action.
 * - Failed run with a recovery audit row renders the Suggested fix block.
 * - Secret-shape values in any source field are scrubbed before render.
 * - Timeline is truncated to the cap when over-cap.
 */
import { describe, expect, it } from "vitest";
import {
  buildRunExplainReport,
  RUN_EXPLAIN_TIMELINE_CAP,
  type RunExplainEventSnapshot,
  type RunExplainNodeSnapshot,
  type RunExplainRecoveryAudit,
  type RunExplainRunSnapshot,
} from "./run-explain-report";

function runSnapshot(overrides: Partial<RunExplainRunSnapshot> = {}): RunExplainRunSnapshot {
  return {
    id: "run_abc123",
    status: "succeeded",
    workflowVersionId: "wf_v3",
    parentRunId: null,
    replayMode: null,
    createdAt: new Date("2026-05-12T15:00:00Z"),
    inputJson: null,
    outputJson: null,
    ...overrides,
  };
}

function eventSnapshot(overrides: Partial<RunExplainEventSnapshot> = {}): RunExplainEventSnapshot {
  return {
    id: "ev1",
    type: "run.started",
    nodeId: null,
    createdAt: new Date("2026-05-12T15:00:00Z"),
    payload: null,
    ...overrides,
  };
}

describe("buildRunExplainReport — clean succeeded run", () => {
  it("renders summary + timeline; no Root cause or Failed node sections", () => {
    const report = buildRunExplainReport({
      run: runSnapshot({ status: "succeeded" }),
      runNodes: [
        {
          nodeId: "start",
          status: "succeeded",
          attempts: 1,
          startedAt: new Date("2026-05-12T15:00:00Z"),
          finishedAt: new Date("2026-05-12T15:00:01Z"),
          stateJson: { output: {} },
          errorJson: null,
        },
      ],
      runEvents: [
        eventSnapshot({ id: "ev1", type: "run.started" }),
        eventSnapshot({ id: "ev2", type: "node.succeeded", nodeId: "start", createdAt: new Date("2026-05-12T15:00:01Z") }),
      ],
      recoveryAudit: null,
    });

    expect(report.json.summary.isFailure).toBe(false);
    expect(report.json.rootCause).toBeNull();
    expect(report.json.failedNode).toBeNull();
    expect(report.json.suggestedFix).toBeNull();
    expect(report.json.nextAction).toMatch(/no operator action/i);

    expect(report.markdown).toContain("# Run Explain Report — run_abc123");
    expect(report.markdown).toContain("**Status:** succeeded");
    expect(report.markdown).not.toMatch(/## Root cause/);
    expect(report.markdown).not.toMatch(/## Failed node/);
    expect(report.markdown).toContain("## Timeline");
    expect(report.markdown).toContain("## Suggested fix");
    expect(report.markdown).toMatch(/No prior recovery suggestion/i);
  });
});

describe("buildRunExplainReport — failed run with errorJson", () => {
  it("renders root cause via normalizeErrorSignature and the failed-node block", () => {
    const report = buildRunExplainReport({
      run: runSnapshot({ status: "failed" }),
      runNodes: [
        {
          nodeId: "start",
          status: "succeeded",
          attempts: 1,
          startedAt: new Date("2026-05-12T15:00:00Z"),
          finishedAt: new Date("2026-05-12T15:00:01Z"),
          stateJson: { output: {} },
          errorJson: null,
        },
        {
          nodeId: "notify",
          status: "failed",
          attempts: 3,
          startedAt: new Date("2026-05-12T15:00:02Z"),
          finishedAt: new Date("2026-05-12T15:00:05Z"),
          stateJson: { nodeType: "tool" },
          errorJson: {
            code: "E_SECRET_MISSING",
            secret: "GITHUB_TOKEN",
            message: "Credential GITHUB_TOKEN is not set in the environment.",
          },
        },
      ],
      runEvents: [eventSnapshot({ type: "run.started" })],
      recoveryAudit: null,
    });

    expect(report.json.summary.isFailure).toBe(true);
    expect(report.json.rootCause).not.toBeNull();
    expect(report.json.rootCause?.category).toBe("secret_missing");
    // secret_missing → ops in the shared taxonomy.
    expect(report.json.rootCause?.suggestedOwner).toBe("ops");

    expect(report.json.failedNode).not.toBeNull();
    expect(report.json.failedNode?.nodeId).toBe("notify");
    expect(report.json.failedNode?.attempts).toBe(3);

    expect(report.markdown).toContain("## Root cause");
    expect(report.markdown).toContain("**Category:** secret_missing");
    expect(report.markdown).toContain("**Suggested owner:** ops");
    expect(report.markdown).toContain("## Failed node");
    expect(report.markdown).toContain("`notify`");
    expect(report.markdown).toContain("**Attempts:** 3");

    expect(report.json.nextAction).toMatch(/secret|credential/i);
  });

  it("picks the LATEST failed node when multiple parallel branches failed", () => {
    const report = buildRunExplainReport({
      run: runSnapshot({ status: "failed" }),
      runNodes: [
        {
          nodeId: "branch_a",
          status: "failed",
          attempts: 1,
          startedAt: new Date("2026-05-12T15:00:00Z"),
          finishedAt: new Date("2026-05-12T15:00:01Z"),
          errorJson: { message: "branch a" },
        },
        {
          nodeId: "branch_b",
          status: "failed",
          attempts: 1,
          startedAt: new Date("2026-05-12T15:00:02Z"),
          finishedAt: new Date("2026-05-12T15:00:03Z"),
          errorJson: { message: "branch b" },
        },
      ],
      runEvents: [],
      recoveryAudit: null,
    });

    expect(report.json.failedNode?.nodeId).toBe("branch_b");
  });
});

describe("buildRunExplainReport — recovery audit row present", () => {
  it("renders the Suggested fix block with metadata fields", () => {
    const audit: RunExplainRecoveryAudit = {
      createdAt: new Date("2026-05-12T15:05:00Z"),
      metadata: {
        mode: "ai",
        model: "claude-haiku-4-5-20251001",
        provider: "anthropic",
        envelopeKind: "structural",
        patchStyle: "structural",
        topApproachLabel: "add_approval",
        suggestionsCount: 3,
      },
    };

    const report = buildRunExplainReport({
      run: runSnapshot({ status: "failed" }),
      runNodes: [
        {
          nodeId: "charge",
          status: "failed",
          attempts: 1,
          startedAt: new Date("2026-05-12T15:00:00Z"),
          finishedAt: new Date("2026-05-12T15:00:01Z"),
          errorJson: { code: "E_READINESS_FAIL", message: "Write-side action requires upstream approval (POST /charges)" },
        },
      ],
      runEvents: [],
      recoveryAudit: audit,
    });

    expect(report.json.suggestedFix).not.toBeNull();
    expect(report.json.suggestedFix?.topApproachLabel).toBe("add_approval");
    expect(report.json.suggestedFix?.envelopeKind).toBe("structural");
    expect(report.json.suggestedFix?.patchStyle).toBe("structural");
    expect(report.json.suggestedFix?.suggestionsCount).toBe(3);

    expect(report.markdown).toContain("**Mode:** ai");
    expect(report.markdown).toContain("**Approach:** add_approval");
    expect(report.markdown).toContain("**Envelope:** structural");
    expect(report.markdown).toContain("**Patch style:** structural");
    expect(report.markdown).toContain("**Alternatives proposed:** 3");
  });

  it("handles missing patchStyle metadata by surfacing 'unknown'", () => {
    const audit: RunExplainRecoveryAudit = {
      createdAt: new Date("2026-05-12T15:05:00Z"),
      metadata: {
        mode: "ai",
        envelopeKind: "http",
        topApproachLabel: "add_retry",
        suggestionsCount: 2,
        // patchStyle absent — legacy audit row.
      },
    };

    const report = buildRunExplainReport({
      run: runSnapshot({ status: "failed" }),
      runNodes: [{ nodeId: "fetch", status: "failed", errorJson: { message: "500" } }],
      runEvents: [],
      recoveryAudit: audit,
    });

    expect(report.json.suggestedFix?.patchStyle).toBe("unknown");
    expect(report.markdown).toContain("**Patch style:** unknown");
  });
});

describe("buildRunExplainReport — secret-shape scrub", () => {
  it("redacts Bearer tokens and sk- patterns in error messages", () => {
    const report = buildRunExplainReport({
      run: runSnapshot({ status: "failed" }),
      runNodes: [
        {
          nodeId: "leaky",
          status: "failed",
          attempts: 1,
          errorJson: {
            message: "401 upstream echoed Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz123",
          },
        },
      ],
      runEvents: [],
      recoveryAudit: null,
    });

    expect(report.markdown).not.toContain("Bearer sk-abcdefghij");
    expect(report.markdown).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123");
    expect(report.markdown).toContain("[redacted]");
    expect(report.json.failedNode?.errorSummary ?? "").not.toContain("sk-abc");
  });

  it("redacts GitHub ghp_ tokens and JWT segments in payload bodies surfaced to the report", () => {
    const ghp = "ghp_aaaaaaaaaaaaaaaaaaaaaa";
    const jwt = "eyJabcdefghij.eyJklmnopqrst.uvwxyz123456";
    const report = buildRunExplainReport({
      run: runSnapshot({ status: "failed" }),
      runNodes: [
        {
          nodeId: "leaky",
          status: "failed",
          attempts: 1,
          errorJson: { message: `Auth issue ${ghp} ${jwt}` },
        },
      ],
      runEvents: [],
      recoveryAudit: null,
    });

    expect(report.markdown).not.toContain(ghp);
    expect(report.markdown).not.toContain(jwt);
    expect(report.markdown).toContain("[redacted]");
  });

  it("redacts secret-shaped values from node ids, event types, and suggested-fix labels", () => {
    const token = "ghp_aaaaaaaaaaaaaaaaaaaaaa";
    const report = buildRunExplainReport({
      run: runSnapshot({ status: "failed" }),
      runNodes: [
        {
          nodeId: `notify_${token}`,
          status: "failed",
          attempts: 1,
          errorJson: { message: "HTTP 500 from upstream" },
        },
      ],
      runEvents: [
        eventSnapshot({
          type: `node.failed.${token}`,
          nodeId: `notify_${token}`,
        }),
      ],
      recoveryAudit: {
        createdAt: new Date("2026-05-12T15:05:00Z"),
        metadata: {
          mode: "ai",
          envelopeKind: `structural_${token}`,
          patchStyle: "structural",
          topApproachLabel: `fix_${token}`,
          suggestionsCount: 1,
        },
      },
    });

    expect(report.markdown).not.toContain(token);
    expect(JSON.stringify(report.json)).not.toContain(token);
    expect(report.markdown).toContain("[redacted]");
    expect(report.json.failedNode?.nodeId).toContain("[redacted]");
    expect(report.json.timeline[0]?.type).toContain("[redacted]");
    expect(report.json.suggestedFix?.topApproachLabel).toContain("[redacted]");
  });
});

describe("buildRunExplainReport — timeline cap", () => {
  it("trims to the last RUN_EXPLAIN_TIMELINE_CAP entries and flags truncation", () => {
    const events: RunExplainEventSnapshot[] = Array.from({ length: RUN_EXPLAIN_TIMELINE_CAP + 20 }, (_, i) => ({
      id: `ev${i}`,
      type: `event-${i}`,
      nodeId: null,
      createdAt: new Date(2026, 4, 12, 15, 0, i),
      payload: null,
    }));

    const report = buildRunExplainReport({
      run: runSnapshot({ status: "succeeded" }),
      runNodes: [],
      runEvents: events,
      recoveryAudit: null,
    });

    expect(report.json.timelineTruncated).toBe(true);
    expect(report.json.timeline).toHaveLength(RUN_EXPLAIN_TIMELINE_CAP);
    expect(report.json.timeline[0]!.type).toBe(`event-20`); // First 20 trimmed.
    expect(report.json.timeline[RUN_EXPLAIN_TIMELINE_CAP - 1]!.type).toBe(`event-${RUN_EXPLAIN_TIMELINE_CAP + 19}`);
    expect(report.markdown).toMatch(/Showing the last 50 events/i);
  });

  it("renders an empty-timeline notice when the run has no events", () => {
    const report = buildRunExplainReport({
      run: runSnapshot({ status: "succeeded" }),
      runNodes: [],
      runEvents: [],
      recoveryAudit: null,
    });
    expect(report.json.timeline).toEqual([]);
    expect(report.markdown).toMatch(/No events recorded yet/i);
  });
});

describe("buildRunExplainReport — replay-mode disclosure", () => {
  it("flags validation runs in the summary so the operator knows it isn't a production run", () => {
    const report = buildRunExplainReport({
      run: runSnapshot({ status: "succeeded", replayMode: "validation", parentRunId: "run_parent_xyz" }),
      runNodes: [],
      runEvents: [],
      recoveryAudit: null,
    });

    expect(report.json.summary.replayMode).toBe("validation");
    expect(report.json.summary.parentRunId).toBe("run_parent_xyz");
    expect(report.markdown).toContain("validation (sandbox — not a production run)");
    expect(report.markdown).toContain("`run_parent_xyz`");
  });
});

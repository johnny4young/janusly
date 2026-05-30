/**
 * Tests for `resolveRecoveryEvidence` — the org-scoped DB resolver that
 * feeds the recovery-evidence builder.
 *
 * The `@janusly/db` mock mirrors Drizzle's awaitable query-builder: every
 * chain method returns the same chain, and the chain resolves the NEXT
 * staged row set from `selectRowsBox` (one set per `db.select()`).
 * `drizzle-orm`'s predicate helpers are stubbed to capture their args so
 * we can assert tenant scope.
 *
 * Coverage targets (the ticket AC):
 * - Tenant scope: the recovery-item read carries `eq(recoveryItems.orgId,
 *   orgId)`; a null first row short-circuits with `null` (no downstream
 *   reads, no enumeration leak).
 * - Large-timeline pagination: the run-event read is bounded by
 *   `RUN_EVENT_FETCH_CAP`; an over-cap result sets
 *   `originalRunEventsTruncated` and trims the returned events.
 * - The full happy path assembles every snapshot + the rollback link.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const selectRowsBox = { rows: [] as unknown[][] };
const eqCalls: Array<[unknown, unknown]> = [];

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: unknown[]) => ({ __and: args })),
  asc: vi.fn(() => ({})),
  desc: vi.fn(() => ({})),
  eq: vi.fn((col: unknown, val: unknown) => {
    eqCalls.push([col, val]);
    return { __eq: [col, val] };
  }),
  inArray: vi.fn((col: unknown, vals: unknown) => ({ __inArray: [col, vals] })),
  lt: vi.fn(() => ({})),
  or: vi.fn((...args: unknown[]) => ({ __or: args })),
  sql: Object.assign(
    vi.fn(() => ({})),
    { raw: vi.fn(() => ({})) },
  ),
}));

vi.mock("@janusly/db", () => {
  const makeChain = () => {
    let cached: Promise<unknown[]> | null = null;
    const settle = (): Promise<unknown[]> => {
      if (!cached) cached = Promise.resolve(selectRowsBox.rows.shift() ?? []);
      return cached;
    };
    const chain: Record<string, unknown> = {
      from: vi.fn(() => chain),
      where: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      then: (resolve: (v: unknown[]) => unknown, reject: (e: unknown) => unknown) => settle().then(resolve, reject),
    };
    return chain;
  };
  const col = (name: string) => name;
  return {
    db: { select: vi.fn(() => makeChain()) },
    recoveryItems: { orgId: "recovery_items.org_id", id: "recovery_items.id" },
    deadLetters: { orgId: "dead_letters.org_id", id: "dead_letters.id" },
    runs: {
      id: "runs.id",
      orgId: "runs.org_id",
      parentRunId: "runs.parent_run_id",
      replayMode: "runs.replay_mode",
      createdAt: "runs.created_at",
    },
    runNodes: { runId: "run_nodes.run_id", startedAt: "run_nodes.started_at", nodeId: "run_nodes.node_id" },
    runEvents: { runId: "run_events.run_id", createdAt: "run_events.created_at", id: "run_events.id" },
    auditLogs: {
      orgId: "audit_logs.org_id",
      action: col("action"),
      createdAt: "audit_logs.created_at",
      metadata: "audit_logs.metadata",
      targetId: "audit_logs.target_id",
      id: "audit_logs.id",
    },
    workflowVersions: {
      orgId: "workflow_versions.org_id",
      id: "workflow_versions.id",
      workflowId: "workflow_versions.workflow_id",
      version: "workflow_versions.version",
    },
  };
});

import {
  RUN_EVENT_FETCH_CAP,
  resolveRecoveryEvidence,
} from "./recoveryEvidenceRepo";

beforeEach(() => {
  selectRowsBox.rows = [];
  eqCalls.length = 0;
});

const itemRow = {
  id: "ri_1",
  orgId: "org-1",
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
  occurrenceCount: 1,
  comments: [],
  createdAt: new Date("2026-05-20T09:00:00Z"),
  updatedAt: new Date("2026-05-20T11:30:00Z"),
};

const dlqRow = {
  id: "dlq_1",
  runId: "run_orig",
  nodeId: "call_api",
  attempt: 3,
  status: "open",
  workflowJson: { name: "Billing flow", nodes: [], edges: [] },
  nodeJson: {},
  errorJson: { message: "401" },
  replayedAt: null,
  createdAt: new Date("2026-05-20T09:00:00Z"),
};

const runRow = {
  id: "run_orig",
  status: "failed",
  workflowVersionId: "wfv_2",
  parentRunId: null,
  replayMode: null,
  inputJson: {},
  outputJson: null,
  createdAt: new Date("2026-05-20T08:55:00Z"),
};

describe("resolveRecoveryEvidence", () => {
  it("returns null and reads nothing downstream when the recovery item is missing / cross-org", async () => {
    selectRowsBox.rows = [[]]; // recovery item read → empty
    const result = await resolveRecoveryEvidence("org-1", "ri_missing");
    expect(result).toBeNull();
    // Exactly ONE select issued (the item read); no DLQ / run / audit reads.
    expect(selectRowsBox.rows.length).toBe(0);
    // The item read carried the org predicate.
    expect(eqCalls).toContainEqual(["recovery_items.org_id", "org-1"]);
    expect(eqCalls).toContainEqual(["recovery_items.id", "ri_missing"]);
  });

  it("scopes the DLQ + run reads to the org (defense in depth)", async () => {
    selectRowsBox.rows = [
      [itemRow], // recovery item
      [dlqRow], // dead letter
      [runRow], // original run
      [], // original run nodes
      [], // original run events
      [], // validation run
      // (no validation nodes read because validation run was empty)
      [], // audit rows
      [{ workflowId: "wf_billing", version: 2 }], // current workflow version
      [{ version: 1 }], // prior version
    ];
    await resolveRecoveryEvidence("org-1", "ri_1");
    expect(eqCalls).toContainEqual(["dead_letters.org_id", "org-1"]);
    expect(eqCalls).toContainEqual(["dead_letters.id", "dlq_1"]);
    expect(eqCalls).toContainEqual(["runs.org_id", "org-1"]);
    expect(eqCalls).toContainEqual(["workflow_versions.org_id", "org-1"]);
  });

  it("bounds the run-event read and flags truncation when over the fetch cap", async () => {
    // Stage RUN_EVENT_FETCH_CAP + 1 event rows so the resolver sees the
    // cap was hit (it fetches CAP+1 then trims).
    const eventRows = Array.from({ length: RUN_EVENT_FETCH_CAP + 1 }, (_, i) => ({
      id: `e${i}`,
      nodeId: "call_api",
      type: `node.step.${i}`,
      createdAt: new Date(Date.parse("2026-05-20T08:00:00Z") + i * 1000),
      payload: null,
    }));
    selectRowsBox.rows = [
      [itemRow],
      [dlqRow],
      [runRow],
      [], // nodes
      eventRows, // events (over cap)
      [], // validation run
      [], // audit rows
      [], // current workflow version (no rollback)
    ];
    const result = await resolveRecoveryEvidence("org-1", "ri_1");
    expect(result).not.toBeNull();
    expect(result!.originalRunEventsTruncated).toBe(true);
    expect(result!.originalRunEvents.length).toBe(RUN_EVENT_FETCH_CAP);
  });

  it("assembles the full bundle with the rollback link", async () => {
    const validationRow = {
      id: "run_val",
      status: "succeeded",
      workflowVersionId: "run_val",
      parentRunId: "run_orig",
      replayMode: "validation",
      inputJson: { workflow: { nodes: [], edges: [] } },
      outputJson: null,
      createdAt: new Date("2026-05-20T10:30:00Z"),
    };
    selectRowsBox.rows = [
      [itemRow], // recovery item
      [dlqRow], // dead letter
      [runRow], // original run
      [{ nodeId: "call_api", status: "failed", attempts: 3, startedAt: null, finishedAt: null, stateJson: { nodeType: "http" }, errorJson: { message: "401" } }], // nodes
      [], // events
      [validationRow], // validation run
      [], // validation nodes
      [{ id: "a1", action: "ai.workflow.patch_suggested", targetType: "dlq", targetId: "dlq_1", userId: "user-alpha", metadata: { mode: "ai" }, createdAt: new Date() }], // audit
      [{ workflowId: "wf_billing", version: 2 }], // current version
      [{ version: 1 }], // prior version
    ];
    const result = await resolveRecoveryEvidence("org-1", "ri_1");
    expect(result).not.toBeNull();
    expect(result!.recoveryItem.id).toBe("ri_1");
    expect(result!.deadLetter?.runId).toBe("run_orig");
    expect(result!.originalRun?.status).toBe("failed");
    expect(result!.validationRun?.id).toBe("run_val");
    expect(result!.auditRows).toHaveLength(1);
    expect(result!.rollback).toEqual({ workflowId: "wf_billing", currentVersion: 2, priorVersion: 1 });
  });

  it("omits the rollback link when no prior version exists", async () => {
    selectRowsBox.rows = [
      [itemRow],
      [dlqRow],
      [runRow],
      [],
      [],
      [], // validation run
      [], // audit rows
      [{ workflowId: "wf_billing", version: 1 }], // current version is v1
      [], // prior version → none
    ];
    const result = await resolveRecoveryEvidence("org-1", "ri_1");
    expect(result!.rollback).toBeNull();
  });
});

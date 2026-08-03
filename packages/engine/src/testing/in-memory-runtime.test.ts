import { describe, expect, it } from "vitest";
import type { Workflow, WorkflowNode } from "@janusly/shared";
import { WorkflowRuntime } from "../core/runtime";
import {
  InMemoryExecutionStore,
  InMemoryQueueAdapter,
  ScriptedNodeExecutorRegistry,
} from "./index";

function workflowWith(nodes: WorkflowNode[], edges: Workflow["edges"]): Workflow {
  return {
    id: "workflow-memory",
    name: "In-memory workflow",
    dslVersion: "1.0",
    nodes,
    edges,
  };
}

function queuedNode(nodeId: string) {
  return {
    nodeId,
    status: "queued" as const,
    attempts: 1,
    publicationGeneration: 0,
  };
}

async function executeNext(
  runtime: WorkflowRuntime,
  queue: InMemoryQueueAdapter,
  workflow: Workflow,
): Promise<void> {
  const publication = queue.takeNext();
  expect(publication).not.toBeNull();
  const node = workflow.nodes.find((entry) => entry.id === publication!.nodeId);
  expect(node).toBeDefined();
  await runtime.executeQueuedNode({ ...publication!, workflow, node: node! });
}

describe("in-memory runtime testkit", () => {
  it("rejects stale publication generations and recovery tokens", async () => {
    const store = new InMemoryExecutionStore({
      runId: "run-cas",
      nodes: [{
        ...queuedNode("guarded"),
        attempts: 2,
        publicationGeneration: 4,
        recoveryClaimToken: "claim-current",
      }],
    });

    await expect(store.claimNodeForExecution(
      "run-cas",
      "guarded",
      2,
      "claim-current",
      3,
    )).resolves.toBe("not_claimed");
    await expect(store.claimNodeForExecution(
      "run-cas",
      "guarded",
      2,
      "claim-stale",
      4,
    )).resolves.toBe("not_claimed");
    expect(store.getNodeSnapshot("run-cas", "guarded")?.status).toBe("queued");

    await expect(store.claimNodeForExecution(
      "run-cas",
      "guarded",
      2,
      "claim-current",
      4,
    )).resolves.toBe("claimed");
    await expect(store.markNodeSucceeded(
      "run-cas",
      "guarded",
      { stale: true },
      "claim-stale",
    )).resolves.toBe(false);
    await expect(store.markNodeSucceeded(
      "run-cas",
      "guarded",
      { accepted: true },
      "claim-current",
    )).resolves.toBe(true);
    expect(store.getNodeSnapshot("run-cas", "guarded")).toMatchObject({
      status: "succeeded",
      output: { accepted: true },
    });
  });

  it("restores an exact queued generation when the parent run is failed", async () => {
    const store = new InMemoryExecutionStore({
      runId: "run-parent-failed",
      status: "failed",
      nodes: [{
        ...queuedNode("child"),
        publicationGeneration: 3,
      }],
    });

    await expect(store.claimNodeForExecution(
      "run-parent-failed",
      "child",
      1,
      undefined,
      3,
    )).resolves.toBe("run_failed");

    expect(store.getNodeSnapshot("run-parent-failed", "child")).toMatchObject({
      status: "pending",
      publicationGeneration: 3,
      publicationPending: true,
    });
    expect(store.listEvents("run-parent-failed")).toEqual([
      expect.objectContaining({
        type: "node.skipped",
        payload: expect.objectContaining({
          reason: "Run failed",
          restoredForRecovery: true,
        }),
      }),
    ]);
  });

  it("executes a two-step workflow through real readiness and terminal rollup", async () => {
    const fetchNode: WorkflowNode = { id: "fetch", type: "noop", config: {} };
    const transformNode: WorkflowNode = { id: "transform", type: "noop", config: {} };
    const workflow = workflowWith(
      [fetchNode, transformNode],
      [{ id: "fetch-transform", from: "fetch", to: "transform" }],
    );
    const store = new InMemoryExecutionStore({
      runId: "run-success",
      nodes: [queuedNode("fetch"), { nodeId: "transform" }],
    });
    const queue = new InMemoryQueueAdapter(store);
    const executors = new ScriptedNodeExecutorRegistry()
      .onNode("fetch", async () => ({ status: "succeeded", output: { amount: 42 } }))
      .onNode("transform", async (input) => ({
        status: "succeeded",
        output: { observed: input.context.fetch },
      }));
    const runtime = new WorkflowRuntime(store, queue, executors);

    await runtime.executeQueuedNode({ runId: "run-success", workflow, node: fetchNode });

    expect(store.getNodeSnapshot("run-success", "fetch")).toMatchObject({
      status: "succeeded",
      output: { amount: 42 },
    });
    expect(store.getNodeSnapshot("run-success", "transform")).toMatchObject({
      status: "queued",
      attempts: 1,
      publicationGeneration: 1,
      publicationPending: false,
    });
    expect(queue.listEnqueued()).toEqual([
      expect.objectContaining({ runId: "run-success", nodeId: "transform", attempt: 1 }),
    ]);

    await executeNext(runtime, queue, workflow);

    expect(store.getRunSnapshot("run-success")?.status).toBe("succeeded");
    expect(store.getNodeSnapshot("run-success", "transform")).toMatchObject({
      status: "succeeded",
      output: {
        observed: expect.objectContaining({
          status: "succeeded",
          output: { amount: 42 },
        }),
      },
    });
    expect(store.listEvents("run-success").map((event) => event.type)).toEqual([
      "node.running",
      "node.succeeded",
      "node.queued",
      "node.running",
      "node.succeeded",
      "run.succeeded",
      "run.status_checked",
    ]);
  });

  it("retries one generation and succeeds without replacing adapter methods", async () => {
    const node: WorkflowNode = {
      id: "retryable",
      type: "noop",
      config: { retry: { maxAttempts: 2, delayMs: 25 } },
    };
    const workflow = workflowWith([node], []);
    const store = new InMemoryExecutionStore({
      runId: "run-retry",
      nodes: [queuedNode(node.id)],
    });
    const queue = new InMemoryQueueAdapter(store);
    let calls = 0;
    const executors = new ScriptedNodeExecutorRegistry().onNode(node.id, async () => {
      calls += 1;
      if (calls === 1) throw new Error("controlled first-attempt failure");
      return { status: "succeeded", output: { calls } };
    });
    const runtime = new WorkflowRuntime(store, queue, executors);

    await runtime.executeQueuedNode({ runId: "run-retry", workflow, node });

    expect(store.getNodeSnapshot("run-retry", node.id)).toMatchObject({
      status: "queued",
      attempts: 2,
      publicationGeneration: 1,
      publicationPending: false,
      publicationDelayMs: 25,
    });
    expect(queue.listEnqueued()).toEqual([
      expect.objectContaining({ attempt: 2, delayMs: 25, publicationGeneration: 1 }),
    ]);

    await executeNext(runtime, queue, workflow);

    expect(calls).toBe(2);
    expect(store.getRunSnapshot("run-retry")?.status).toBe("succeeded");
    expect(store.listEvents("run-retry").map((event) => event.type)).toContain("node.retry");
    expect(queue.listTerminalFailures()).toEqual([]);
  });

  it("commits an exhausted failure to the in-memory DLQ boundary", async () => {
    const node: WorkflowNode = { id: "broken", type: "noop", config: {} };
    const workflow = workflowWith([node], []);
    const store = new InMemoryExecutionStore({
      runId: "run-failed",
      nodes: [queuedNode(node.id)],
    });
    const queue = new InMemoryQueueAdapter(store);
    const executors = new ScriptedNodeExecutorRegistry().onNode(node.id, async () => {
      throw new Error("deterministic validation failure");
    });
    const runtime = new WorkflowRuntime(store, queue, executors);

    await expect(runtime.executeQueuedNode({ runId: "run-failed", workflow, node }))
      .rejects.toThrow("deterministic validation failure");

    expect(store.getRunSnapshot("run-failed")?.status).toBe("failed");
    expect(store.getNodeSnapshot("run-failed", node.id)).toMatchObject({
      status: "failed",
      error: { message: "deterministic validation failure" },
    });
    expect(queue.listTerminalFailures()).toEqual([
      expect.objectContaining({ runId: "run-failed", node, attempt: 1 }),
    ]);
    expect(store.listEvents("run-failed").map((event) => event.type)).toEqual([
      "node.running",
      "node.failed",
      "run.failed",
    ]);
  });

  it("quarantines a semantic violation before publishing the effect successor", async () => {
    const aiNode: WorkflowNode = { id: "ai", type: "noop", config: {} };
    const effectNode: WorkflowNode = { id: "notify", type: "noop", config: {} };
    const workflow: Workflow = {
      ...workflowWith(
        [aiNode, effectNode],
        [{ id: "ai-notify", from: "ai", to: "notify" }],
      ),
      recovery: {
        contract: {
          version: "2",
          failure: {
            technical: { terminalNodeFailure: true, stalledNode: true },
            semantic: {
              mode: "deterministic",
              detectors: [{
                id: "ai-mode",
                sourceNodeId: "ai",
                kind: "expression",
                passWhen: 'context.ai.output.mode === "ai"',
                action: "quarantine",
                message: "AI output is required",
              }],
              evaluationFixtures: [
                { id: "pass", sourceNodeId: "ai", output: { mode: "ai" }, expected: "pass" },
                { id: "fail", sourceNodeId: "ai", output: { mode: "fallback" }, expected: "violation" },
              ],
            },
          },
          evidence: { required: ["failure_snapshot", "audit_trail", "terminal_outcome"] },
          effects: [],
          repairs: { allowed: ["retry"] },
          validation: { minimumEvidenceLevel: "static" },
          approval: { productionMutation: "required", permission: "recovery.write" },
          autonomyLevel: 3,
          verification: { kind: "generation_bound_terminal_success" },
          recurrence: { windowDays: 7 },
        },
      },
    };
    const store = new InMemoryExecutionStore({
      runId: "run-semantic",
      nodes: [queuedNode(aiNode.id), { nodeId: effectNode.id }],
    });
    const queue = new InMemoryQueueAdapter(store);
    const executors = new ScriptedNodeExecutorRegistry().onNode(aiNode.id, async () => ({
      status: "succeeded",
      output: { mode: "fallback" },
    }));
    const runtime = new WorkflowRuntime(store, queue, executors);

    await runtime.executeQueuedNode({ runId: "run-semantic", workflow, node: aiNode });

    expect(store.getRunSnapshot("run-semantic")?.status).toBe("waiting");
    expect(store.getNodeSnapshot("run-semantic", aiNode.id)?.status).toBe("succeeded");
    expect(store.getNodeSnapshot("run-semantic", effectNode.id)?.status).toBe("pending");
    expect(queue.listEnqueued()).toEqual([]);
    expect(store.listSemanticCases("run-semantic")).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^sem_[a-f0-9]{32}$/),
        violation: expect.objectContaining({ detectorId: "ai-mode", action: "quarantine" }),
      }),
    ]);
    expect(store.listEvents("run-semantic").map((event) => event.type)).toEqual([
      "node.running",
      "node.succeeded",
      "recovery.semantic_violation",
    ]);
  });
});

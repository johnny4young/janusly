import { describe, expect, it } from "vitest";
import { clusterFailureSamples, type FailureSample } from "./cluster-failures";

function sample(partial: Partial<FailureSample>): FailureSample {
  return {
    source: "dead_letter",
    id: "dlq-1",
    workflowId: "wf-a",
    workflowName: "Workflow A",
    runId: "run-1",
    nodeId: "node-1",
    nodeType: "http",
    errorJson: { message: "HTTP 401 from upstream" },
    createdAt: new Date("2026-01-01T10:00:00Z"),
    ...partial,
  };
}

describe("clusterFailureSamples", () => {
  it("groups two rows with the same signature into one cluster", () => {
    const clusters = clusterFailureSamples([
      sample({ id: "dlq-1", runId: "run-1", nodeId: "node-1" }),
      sample({ id: "dlq-2", runId: "run-2", nodeId: "node-2" }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].signature).toBe("HTTP 401 on http node");
    expect(clusters[0].frequency).toBe(2);
    expect(clusters[0].affectedWorkflows).toEqual([
      { workflowId: "wf-a", workflowName: "Workflow A", count: 2 },
    ]);
    expect(clusters[0].samples).toHaveLength(2);
  });

  it("counts affected workflows separately when the same signature spans two workflows", () => {
    const clusters = clusterFailureSamples([
      sample({ id: "dlq-1", runId: "run-1", nodeId: "node-1", workflowId: "wf-a", workflowName: "A" }),
      sample({ id: "dlq-2", runId: "run-2", nodeId: "node-2", workflowId: "wf-a", workflowName: "A" }),
      sample({ id: "dlq-3", runId: "run-3", nodeId: "node-3", workflowId: "wf-b", workflowName: "B" }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].frequency).toBe(3);
    expect(clusters[0].affectedWorkflows).toEqual([
      { workflowId: "wf-a", workflowName: "A", count: 2 },
      { workflowId: "wf-b", workflowName: "B", count: 1 },
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(clusterFailureSamples([])).toEqual([]);
  });

  it("deduplicates a (runId, nodeId) pair across DLQ + failed-run-node sources, preferring DLQ", () => {
    // Same run + node, two sources — only the DLQ version contributes to
    // the cluster count.
    const clusters = clusterFailureSamples([
      sample({ source: "failed_run_node", id: "run-1:node-1", runId: "run-1", nodeId: "node-1" }),
      sample({ source: "dead_letter", id: "dlq-1", runId: "run-1", nodeId: "node-1" }),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].frequency).toBe(1);
    expect(clusters[0].samples[0]).toMatchObject({ source: "dead_letter", id: "dlq-1" });
  });

  it("sorts clusters descending by frequency", () => {
    const clusters = clusterFailureSamples([
      sample({ id: "a", runId: "run-1", nodeId: "n-1", errorJson: { message: "secret 'X' not found" } }),
      sample({ id: "b", runId: "run-2", nodeId: "n-2", errorJson: { message: "HTTP 500 from upstream" } }),
      sample({ id: "c", runId: "run-3", nodeId: "n-3", errorJson: { message: "HTTP 500 from upstream" } }),
      sample({ id: "d", runId: "run-4", nodeId: "n-4", errorJson: { message: "HTTP 500 from upstream" } }),
    ]);
    expect(clusters[0].signature).toBe("HTTP 500 on http node");
    expect(clusters[0].frequency).toBe(3);
    expect(clusters[1].signature).toBe("Missing secret: X");
    expect(clusters[1].frequency).toBe(1);
  });
});

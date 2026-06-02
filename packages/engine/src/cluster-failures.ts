/**
 * Pure aggregator that walks a flat list of failure samples (DLQ rows +
 * failed `run_nodes` rows) and groups them by normalized error signature.
 * Output: an ordered list of `FailureCluster` rows the operator's
 * Recovery Queue renders to answer "are these 23 failures one problem or
 * many?".
 *
 * Pattern matches `workflow-health.ts` — pure module, easy to unit-test
 * with hand-rolled samples. No I/O. The DB layer
 * (`packages/data/src/failureClusterRepo.ts`) supplies the samples; the
 * API route (`apps/api/src/routes/dlq-routes.ts:GET /dlq/clusters`) wires them
 * together.
 *
 * Deduplication: when a failed run lands in DLQ, both surfaces emit a
 * sample — the failed `run_nodes` row AND the `dead_letters` row. The
 * aggregator keeps only the DLQ-source sample for any `(runId, nodeId)`
 * pair, so cluster counts reflect distinct failure events rather than
 * double-counting.
 *
 * Used by `apps/api/src/routes/dlq-routes.ts:GET /dlq/clusters`.
 */

import {
  normalizeErrorSignature,
  scrubSecretShapes,
  type ErrorCategory,
  type SuggestedOwner,
} from "./error-signature";

/** One row read from either `dead_letters` or a failed `run_nodes` row. */
export type FailureSample = {
  source: "dead_letter" | "failed_run_node";
  /** Stable identifier for drill-down — DLQ id for `dead_letter`, composite `runId:nodeId` for `failed_run_node`. */
  id: string;
  workflowId: string;
  workflowName: string;
  runId: string;
  nodeId: string;
  /** Failing node's type (e.g. `"http"`, `"ai"`, `"tool"`). Drives the signature template. */
  nodeType: string;
  /** Optional resolved tool name for `tool` nodes — used by the `tool_input` rule. */
  toolName?: string;
  /** The error envelope as persisted; safe-persist already key-redacted before this point. */
  errorJson: unknown;
  createdAt: Date;
};

/** Per-cluster workflow membership + occurrence count. */
export type ClusterWorkflow = {
  workflowId: string;
  workflowName: string;
  count: number;
};

/** One representative sample id used for drill-down from the cluster row. */
export type ClusterSampleRef = {
  source: "dead_letter" | "failed_run_node";
  id: string;
  runId: string;
};

/** Aggregated cluster row exposed to the API + UI. */
export type FailureCluster = {
  signature: string;
  category: ErrorCategory;
  frequency: number;
  affectedWorkflows: ClusterWorkflow[];
  /** ISO 8601. Earliest createdAt across the cluster's samples. */
  firstSeen: string;
  /** ISO 8601. Latest createdAt across the cluster's samples. */
  lastSeen: string;
  suggestedOwner: SuggestedOwner;
  /** Up to 5 representative sample refs, newest first. */
  samples: ClusterSampleRef[];
};

/** Maximum sample refs surfaced per cluster — keeps the API payload tidy. */
export const CLUSTER_SAMPLE_LIMIT = 5;

/** Group raw failure samples by normalized signature; sort descending by frequency. */
export function clusterFailureSamples(samples: FailureSample[]): FailureCluster[] {
  // Deduplicate by (runId, nodeId) preferring the DLQ-source sample so a
  // failed run that landed in DLQ doesn't count twice.
  const dedupedMap = new Map<string, FailureSample>();
  for (const sample of samples) {
    const key = `${sample.runId}:${sample.nodeId}`;
    const existing = dedupedMap.get(key);
    if (!existing) {
      dedupedMap.set(key, sample);
      continue;
    }
    if (existing.source !== "dead_letter" && sample.source === "dead_letter") {
      dedupedMap.set(key, sample);
    }
  }

  // Map<signature, accumulator> — accumulator owns affected-workflow counts
  // via an inner Map<workflowId, ClusterWorkflow>.
  type Accumulator = {
    signature: string;
    category: ErrorCategory;
    suggestedOwner: SuggestedOwner;
    frequency: number;
    workflows: Map<string, ClusterWorkflow>;
    firstSeen: Date;
    lastSeen: Date;
    samples: ClusterSampleRef[];
  };
  const clusters = new Map<string, Accumulator>();

  for (const sample of dedupedMap.values()) {
    const { signature, category, suggestedOwner } = normalizeErrorSignature(sample.errorJson, {
      nodeType: sample.nodeType,
      nodeId: sample.nodeId,
      toolName: sample.toolName,
    });

    let acc = clusters.get(signature);
    if (!acc) {
      acc = {
        signature,
        category,
        suggestedOwner,
        frequency: 0,
        workflows: new Map(),
        firstSeen: sample.createdAt,
        lastSeen: sample.createdAt,
        samples: [],
      };
      clusters.set(signature, acc);
    }
    acc.frequency += 1;
    if (sample.createdAt < acc.firstSeen) acc.firstSeen = sample.createdAt;
    if (sample.createdAt > acc.lastSeen) acc.lastSeen = sample.createdAt;

    const workflow = acc.workflows.get(sample.workflowId);
    if (workflow) {
      workflow.count += 1;
    } else {
      acc.workflows.set(sample.workflowId, {
        workflowId: sample.workflowId,
        // Defense-in-depth: workflow names are operator-supplied free
        // text, so a token-shaped name (rare but possible) would bypass
        // the upstream key-redaction. Scrub before surfacing.
        workflowName: scrubSecretShapes(sample.workflowName),
        count: 1,
      });
    }

    if (acc.samples.length < CLUSTER_SAMPLE_LIMIT) {
      acc.samples.push({ source: sample.source, id: sample.id, runId: sample.runId });
    }
  }

  return Array.from(clusters.values())
    .map((acc) => ({
      signature: acc.signature,
      category: acc.category,
      suggestedOwner: acc.suggestedOwner,
      frequency: acc.frequency,
      affectedWorkflows: Array.from(acc.workflows.values()).sort((a, b) => b.count - a.count),
      firstSeen: acc.firstSeen.toISOString(),
      lastSeen: acc.lastSeen.toISOString(),
      samples: acc.samples,
    }))
    .sort((a, b) => b.frequency - a.frequency || (a.signature < b.signature ? -1 : 1));
}

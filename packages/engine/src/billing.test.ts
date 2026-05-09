import { describe, expect, it } from "vitest";
import {
  aggregateUsageBreakdown,
  isUsageBreakdownDimension,
  USAGE_BREAKDOWN_DIMENSIONS,
  type UsageBreakdownBucket,
  type UsageBreakdownDimension,
  type UsageEventRow,
} from "./billing";

const baseAt = new Date("2026-05-08T12:00:00Z");

function row(overrides: Partial<UsageEventRow> & { metadata?: Record<string, unknown> } = {}): UsageEventRow {
  return {
    metric: "llm.completion",
    quantity: 100,
    metadata: overrides.metadata ?? {},
    createdAt: baseAt,
    ...overrides,
  };
}

function bucket(buckets: UsageBreakdownBucket[], key: string): UsageBreakdownBucket | undefined {
  return buckets.find((b) => b.key === key);
}

describe("aggregateUsageBreakdown — empty + single-dimension", () => {
  it("returns [] when no rows are passed", () => {
    expect(aggregateUsageBreakdown([], ["provider"])).toEqual([]);
  });

  it("returns [] when dimensions is empty (caller should use getUsageSummary)", () => {
    expect(aggregateUsageBreakdown([row()], [])).toEqual([]);
  });

  it("groups by single provider dimension", () => {
    const rows: UsageEventRow[] = [
      row({ quantity: 100, metadata: { provider: "anthropic", mode: "ai" } }),
      row({ quantity: 50, metadata: { provider: "anthropic", mode: "ai" } }),
      row({ quantity: 200, metadata: { provider: "openai", mode: "ai" } }),
    ];
    const out = aggregateUsageBreakdown(rows, ["provider"]);
    expect(out).toHaveLength(2);
    expect(bucket(out, "provider=anthropic")?.quantity).toBe(150);
    expect(bucket(out, "provider=anthropic")?.callCount).toBe(2);
    expect(bucket(out, "provider=openai")?.quantity).toBe(200);
    expect(bucket(out, "provider=openai")?.callCount).toBe(1);
  });

  it("populates only the requested dimension fields on each bucket", () => {
    const out = aggregateUsageBreakdown(
      [row({ metadata: { provider: "anthropic", model: "haiku", mode: "ai" } })],
      ["provider"],
    );
    expect(out[0]!.provider).toBe("anthropic");
    expect(out[0]!.model).toBeUndefined();
    expect(out[0]!.mode).toBeUndefined();
    expect(out[0]!.day).toBeUndefined();
  });
});

describe("aggregateUsageBreakdown — multi-dimension", () => {
  it("groups by provider + model — same provider with different models becomes two buckets", () => {
    const rows: UsageEventRow[] = [
      row({ quantity: 100, metadata: { provider: "anthropic", model: "haiku" } }),
      row({ quantity: 200, metadata: { provider: "anthropic", model: "haiku" } }),
      row({ quantity: 150, metadata: { provider: "anthropic", model: "sonnet" } }),
    ];
    const out = aggregateUsageBreakdown(rows, ["provider", "model"]);
    expect(out).toHaveLength(2);
    expect(bucket(out, "provider=anthropic|model=haiku")?.quantity).toBe(300);
    expect(bucket(out, "provider=anthropic|model=sonnet")?.quantity).toBe(150);
  });

  it("dedupes repeated dimensions while preserving first-occurrence order", () => {
    const rows: UsageEventRow[] = [
      row({ metadata: { provider: "anthropic" } }),
    ];
    const out = aggregateUsageBreakdown(rows, ["provider", "provider", "provider"] as UsageBreakdownDimension[]);
    expect(out).toHaveLength(1);
    expect(out[0]!.key).toBe("provider=anthropic");
  });

  it("groups missing-metadata rows under `unknown` per dimension (not dropped)", () => {
    const rows: UsageEventRow[] = [
      row({ metadata: {} }), // no provider, no model, no mode
      row({ metadata: { provider: "anthropic" } }),
    ];
    const out = aggregateUsageBreakdown(rows, ["provider"]);
    expect(out).toHaveLength(2);
    expect(bucket(out, "provider=unknown")?.callCount).toBe(1);
    expect(bucket(out, "provider=anthropic")?.callCount).toBe(1);
  });
});

describe("aggregateUsageBreakdown — mode dimension and fallbackCount", () => {
  it("ai vs fallback rows become two buckets when grouped by mode", () => {
    const rows: UsageEventRow[] = [
      row({ metadata: { provider: "anthropic", mode: "ai" } }),
      row({ metadata: { provider: "anthropic", mode: "ai" } }),
      row({ metadata: { provider: "anthropic", mode: "fallback" } }),
    ];
    const out = aggregateUsageBreakdown(rows, ["mode"]);
    expect(out).toHaveLength(2);
    expect(bucket(out, "mode=ai")?.callCount).toBe(2);
    expect(bucket(out, "mode=fallback")?.callCount).toBe(1);
  });

  it("fallbackCount tallies rows where metadata.mode === 'fallback' regardless of grouping", () => {
    const rows: UsageEventRow[] = [
      row({ metadata: { provider: "anthropic", mode: "ai" } }),
      row({ metadata: { provider: "anthropic", mode: "fallback" } }),
      row({ metadata: { provider: "anthropic", mode: "fallback" } }),
    ];
    const out = aggregateUsageBreakdown(rows, ["provider"]);
    expect(out).toHaveLength(1);
    expect(bucket(out, "provider=anthropic")?.fallbackCount).toBe(2);
  });

  it("populates `mode` field on the bucket only when mode is in the dimensions list", () => {
    const out = aggregateUsageBreakdown(
      [row({ metadata: { provider: "anthropic", mode: "ai" } })],
      ["provider", "mode"],
    );
    expect(out[0]!.mode).toBe("ai");
  });
});

describe("aggregateUsageBreakdown — costUsd null handling", () => {
  it("sums costUsd across rows with non-null values", () => {
    const rows: UsageEventRow[] = [
      row({ metadata: { provider: "anthropic", costUsd: 0.10 } }),
      row({ metadata: { provider: "anthropic", costUsd: 0.20 } }),
      row({ metadata: { provider: "anthropic", costUsd: 0.05 } }),
    ];
    const out = aggregateUsageBreakdown(rows, ["provider"]);
    expect(bucket(out, "provider=anthropic")?.costUsd).toBeCloseTo(0.35, 5);
  });

  it("returns null when EVERY row in the bucket has null/missing costUsd (unknown-model case)", () => {
    const rows: UsageEventRow[] = [
      row({ metadata: { provider: "ollama" } }),
      row({ metadata: { provider: "ollama", costUsd: null } }),
    ];
    const out = aggregateUsageBreakdown(rows, ["provider"]);
    expect(bucket(out, "provider=ollama")?.costUsd).toBeNull();
  });

  it("sums only non-null values when the bucket mixes null and non-null", () => {
    const rows: UsageEventRow[] = [
      row({ metadata: { provider: "anthropic", costUsd: 0.10 } }),
      row({ metadata: { provider: "anthropic" } }),
      row({ metadata: { provider: "anthropic", costUsd: 0.20 } }),
    ];
    const out = aggregateUsageBreakdown(rows, ["provider"]);
    expect(bucket(out, "provider=anthropic")?.costUsd).toBeCloseTo(0.30, 5);
  });
});

describe("aggregateUsageBreakdown — latency aggregates", () => {
  it("computes p50, p95, and avg over a known dataset", () => {
    const latencies = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const rows: UsageEventRow[] = latencies.map((latencyMs) => row({
      metadata: { provider: "anthropic", latencyMs },
    }));
    const out = aggregateUsageBreakdown(rows, ["provider"]);
    const b = bucket(out, "provider=anthropic")!;
    // p50 with N=10 → ceil(0.5 * 10) - 1 = 4 → sorted[4] = 50
    expect(b.latency.p50Ms).toBe(50);
    // p95 with N=10 → ceil(0.95 * 10) - 1 = 9 → sorted[9] = 100
    expect(b.latency.p95Ms).toBe(100);
    // avg = (10+20+...+100) / 10 = 55
    expect(b.latency.avgMs).toBe(55);
  });

  it("returns null aggregates when no rows in the bucket have a latency value", () => {
    const rows: UsageEventRow[] = [
      row({ metadata: { provider: "anthropic" } }),
      row({ metadata: { provider: "anthropic", latencyMs: null } }),
    ];
    const out = aggregateUsageBreakdown(rows, ["provider"]);
    const b = bucket(out, "provider=anthropic")!;
    expect(b.latency.p50Ms).toBeNull();
    expect(b.latency.p95Ms).toBeNull();
    expect(b.latency.avgMs).toBeNull();
  });

  it("ignores rows with non-numeric latency values when computing aggregates", () => {
    const rows: UsageEventRow[] = [
      row({ metadata: { provider: "anthropic", latencyMs: 100 } }),
      row({ metadata: { provider: "anthropic", latencyMs: 200 } }),
      row({ metadata: { provider: "anthropic" } }), // skipped
    ];
    const out = aggregateUsageBreakdown(rows, ["provider"]);
    const b = bucket(out, "provider=anthropic")!;
    // Only [100, 200] participate → avg = 150
    expect(b.latency.avgMs).toBe(150);
  });
});

describe("aggregateUsageBreakdown — day dimension", () => {
  it("buckets by UTC YYYY-MM-DD regardless of intra-day timestamps", () => {
    const rows: UsageEventRow[] = [
      row({ createdAt: new Date("2026-05-08T01:00:00Z") }),
      row({ createdAt: new Date("2026-05-08T23:59:59Z") }),
      row({ createdAt: new Date("2026-05-09T00:00:01Z") }),
    ];
    const out = aggregateUsageBreakdown(rows, ["day"]);
    expect(out).toHaveLength(2);
    expect(bucket(out, "day=2026-05-08")?.callCount).toBe(2);
    expect(bucket(out, "day=2026-05-09")?.callCount).toBe(1);
  });

  it("falls back to `unknown` when createdAt is null", () => {
    const out = aggregateUsageBreakdown([row({ createdAt: null })], ["day"]);
    expect(out[0]!.key).toBe("day=unknown");
    expect(out[0]!.day).toBe("unknown");
  });
});

describe("aggregateUsageBreakdown — node dimension", () => {
  it("groups by metadata.nodeId and falls back to `unknown` when missing", () => {
    const rows: UsageEventRow[] = [
      row({ metadata: { provider: "anthropic", nodeId: "summarize" } }),
      row({ metadata: { provider: "anthropic", nodeId: "summarize" } }),
      row({ metadata: { provider: "anthropic", nodeId: "router" } }),
      row({ metadata: { provider: "anthropic" } }), // no nodeId
    ];
    const out = aggregateUsageBreakdown(rows, ["node"]);
    expect(out).toHaveLength(3);
    expect(bucket(out, "node=summarize")?.callCount).toBe(2);
    expect(bucket(out, "node=router")?.callCount).toBe(1);
    expect(bucket(out, "node=unknown")?.callCount).toBe(1);
  });

  it("populates `node` field on the bucket when in the dimensions list", () => {
    const out = aggregateUsageBreakdown(
      [row({ metadata: { provider: "anthropic", nodeId: "summarize" } })],
      ["provider", "node"],
    );
    expect(out[0]!.provider).toBe("anthropic");
    expect(out[0]!.node).toBe("summarize");
  });
});

describe("aggregateUsageBreakdown — workflow dimension", () => {
  it("groups by metadata.workflowId — same workflow across nodes is one bucket", () => {
    const rows: UsageEventRow[] = [
      row({ metadata: { workflowId: "wf-incident-triage", nodeId: "n1" } }),
      row({ metadata: { workflowId: "wf-incident-triage", nodeId: "n2" } }),
      row({ metadata: { workflowId: "wf-refund-flow", nodeId: "n1" } }),
    ];
    const out = aggregateUsageBreakdown(rows, ["workflow"]);
    expect(out).toHaveLength(2);
    expect(bucket(out, "workflow=wf-incident-triage")?.callCount).toBe(2);
    expect(bucket(out, "workflow=wf-refund-flow")?.callCount).toBe(1);
  });

  it("buckets `/ai/generate-workflow`-style rows (no workflowId) under `workflow=unknown`", () => {
    const rows: UsageEventRow[] = [
      row({ metadata: { workflowId: "wf-saved" } }),
      row({ metadata: {} }), // generate-workflow path
    ];
    const out = aggregateUsageBreakdown(rows, ["workflow"]);
    expect(out).toHaveLength(2);
    expect(bucket(out, "workflow=wf-saved")?.callCount).toBe(1);
    expect(bucket(out, "workflow=unknown")?.callCount).toBe(1);
  });

  it("workflow + node grouped together highlights per-workflow node hotspots", () => {
    const rows: UsageEventRow[] = [
      row({ quantity: 1000, metadata: { workflowId: "wf-a", nodeId: "summarize" } }),
      row({ quantity: 2000, metadata: { workflowId: "wf-a", nodeId: "summarize" } }),
      row({ quantity: 500, metadata: { workflowId: "wf-a", nodeId: "router" } }),
      row({ quantity: 4000, metadata: { workflowId: "wf-b", nodeId: "summarize" } }),
    ];
    const out = aggregateUsageBreakdown(rows, ["workflow", "node"]);
    expect(out).toHaveLength(3);
    expect(bucket(out, "workflow=wf-a|node=summarize")?.quantity).toBe(3000);
    expect(bucket(out, "workflow=wf-a|node=router")?.quantity).toBe(500);
    expect(bucket(out, "workflow=wf-b|node=summarize")?.quantity).toBe(4000);
  });
});

describe("USAGE_BREAKDOWN_DIMENSIONS + isUsageBreakdownDimension", () => {
  it("exports the closed six-axis enum", () => {
    expect([...USAGE_BREAKDOWN_DIMENSIONS]).toEqual([
      "provider",
      "model",
      "mode",
      "day",
      "node",
      "workflow",
    ]);
  });

  it("type guard accepts known dimensions", () => {
    expect(isUsageBreakdownDimension("provider")).toBe(true);
    expect(isUsageBreakdownDimension("model")).toBe(true);
    expect(isUsageBreakdownDimension("mode")).toBe(true);
    expect(isUsageBreakdownDimension("day")).toBe(true);
    expect(isUsageBreakdownDimension("node")).toBe(true);
    expect(isUsageBreakdownDimension("workflow")).toBe(true);
  });

  it("type guard rejects unknown values", () => {
    expect(isUsageBreakdownDimension("region")).toBe(false);
    expect(isUsageBreakdownDimension("")).toBe(false);
    expect(isUsageBreakdownDimension(null)).toBe(false);
    expect(isUsageBreakdownDimension(42)).toBe(false);
  });
});

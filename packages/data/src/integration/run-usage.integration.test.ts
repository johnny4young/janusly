/** Real-Postgres proof for tenant-scoped, resource-backed run diagnostics. */

import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { db, runs, usageEvents } from "@janusly/db";
import {
  COST_BREAKDOWN_GROUP_CAP,
  queryRecoveryMetricsSignals,
} from "../recoveryMetricsRepo";
import { queryRunUsage } from "../runUsageRepo";

const TAG = `${Date.now()}-${process.pid}`;
const ORG = `run-usage-${TAG}`;
const OTHER_ORG = `run-usage-other-${TAG}`;
const COST_ORG = `run-usage-cost-${TAG}`;
const CARDINALITY_ORG = `run-usage-cardinality-${TAG}`;
const RUN_ID = `run-usage-run-${TAG}`;

afterAll(async () => {
  await db.delete(usageEvents).where(eq(usageEvents.orgId, COST_ORG));
  await db.delete(usageEvents).where(eq(usageEvents.orgId, CARDINALITY_ORG));
  await db.delete(usageEvents).where(eq(usageEvents.runId, RUN_ID));
  await db.delete(runs).where(eq(runs.id, RUN_ID));
});

describe("run usage projection — real Postgres", () => {
  it("uses the partial run index and excludes another tenant's rows", async () => {
    await db.insert(runs).values({
      id: RUN_ID,
      orgId: ORG,
      workflowVersionId: `version-${TAG}`,
      status: "succeeded",
    });
    await db.insert(usageEvents).values([
      {
        id: `run-usage-llm-${TAG}`,
        orgId: ORG,
        runId: RUN_ID,
        metric: "llm.completion",
        quantity: 120,
        metadata: {
          provider: "anthropic",
          model: "claude-haiku-4-5-20251001",
          inputTokens: 90,
          outputTokens: 30,
          cachedInputTokens: 60,
          cacheCreationInputTokens: 10,
          costUsd: 0.004,
        },
      },
      {
        id: `run-usage-memory-${TAG}`,
        orgId: ORG,
        runId: RUN_ID,
        metric: "memory.recall",
        quantity: 1,
        metadata: { kind: "agent_episode", ok: true },
      },
      {
        id: `run-usage-foreign-${TAG}`,
        orgId: OTHER_ORG,
        runId: RUN_ID,
        metric: "llm.completion",
        quantity: 999,
        metadata: { inputTokens: 999, outputTokens: 0, costUsd: 99 },
      },
    ]);

    const summary = await queryRunUsage(ORG, RUN_ID);
    expect(summary.loadedRows).toBe(2);
    expect(summary.llm).toMatchObject({
      calls: 1,
      totalTokens: 120,
      cachedInputTokens: 60,
      cacheCreationInputTokens: 10,
      knownCostUsd: 0.004,
    });
    expect(summary.memory).toMatchObject({ recalls: 1, commits: 0, failures: 0 });

    const recoverySignals = await queryRecoveryMetricsSignals(ORG, 30);
    expect(recoverySignals.costByProvider).toEqual([
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001",
        inputTokens: 90,
        cachedInputTokens: 60,
        cacheCreationInputTokens: 10,
      }),
    ]);

    const indexes = await db.execute<{ indexname: string }>(sql`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'usage_events'
    `);
    expect(Array.from(indexes).map((row) => row.indexname)).toContain("usage_events_org_run_created_idx");
  });

  it("aggregates the complete cost window beyond the former raw-row cap", async () => {
    const rowCount = 10_005;
    const batchSize = 1_000;
    for (let start = 0; start < rowCount; start += batchSize) {
      const size = Math.min(batchSize, rowCount - start);
      await db.insert(usageEvents).values(Array.from({ length: size }, (_, offset) => ({
        id: `run-usage-cost-${TAG}-${start + offset}`,
        orgId: COST_ORG,
        metric: "llm.completion",
        quantity: 2,
        metadata: {
          provider: "anthropic",
          model: "claude-haiku-4-5-20251001",
          inputTokens: 2,
          outputTokens: 0,
          cachedInputTokens: 1,
          cacheCreationInputTokens: 0,
          costUsd: 0.001,
        },
      })));
    }

    const signals = await queryRecoveryMetricsSignals(COST_ORG, 30);
    expect(signals.costByProvider).toHaveLength(1);
    expect(signals.costByProvider[0]).toMatchObject({
      provider: "anthropic",
      calls: rowCount,
      tokens: rowCount * 2,
      inputTokens: rowCount * 2,
      cachedInputTokens: rowCount,
    });
    expect(signals.costByProvider[0]?.usd).toBeCloseTo(rowCount * 0.001, 6);
  });

  it("bounds free-form provider/model cardinality without losing totals", async () => {
    const groupCount = COST_BREAKDOWN_GROUP_CAP + 5;
    await db.insert(usageEvents).values(Array.from({ length: groupCount }, (_, index) => ({
      id: `run-usage-cardinality-${TAG}-${index}`,
      orgId: CARDINALITY_ORG,
      metric: "llm.completion",
      quantity: 2,
      metadata: {
        provider: "anthropic",
        model: `tenant-model-${String(index).padStart(3, "0")}`,
        inputTokens: 2,
        outputTokens: 0,
        cachedInputTokens: 1,
        cacheCreationInputTokens: 0,
        costUsd: 0.001,
      },
    })));

    const signals = await queryRecoveryMetricsSignals(CARDINALITY_ORG, 30);
    expect(signals.costByProvider).toHaveLength(COST_BREAKDOWN_GROUP_CAP + 1);
    expect(signals.costByProvider.filter((row) => !row.aggregated)).toHaveLength(COST_BREAKDOWN_GROUP_CAP);
    expect(signals.costByProvider.find((row) => row.aggregated)).toMatchObject({
      calls: 5,
      tokens: 10,
      inputTokens: 10,
      cachedInputTokens: 5,
    });
    expect(signals.costByProvider.reduce((sum, row) => sum + row.calls, 0)).toBe(groupCount);
    expect(signals.costByProvider.reduce((sum, row) => sum + row.usd, 0)).toBeCloseTo(groupCount * 0.001, 6);
  });
});

/**
 * Integration test (real Postgres + pgvector) for the memory commit → recall
 * round-trip. `generateEmbedding` is stubbed to a fixed 1024-dim vector (the
 * "embedding stub" this follow-up was gated on) so the test exercises the REAL
 * pgvector insert + cosine-similarity `recallMemory` query without an embedding
 * provider. Consent is enabled via the real `upsertOrgConfig` (which also
 * clears the org-config cache). Unique org id + cleanup.
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Stub the embedding provider to a deterministic unit vector (dim 1024 — the
// pgvector column size). Same vector for commit + query → cosine similarity 1,
// so a committed entry is recalled. Keeps every other @janusly/ai export real.
vi.mock("@janusly/ai", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const embedding = new Array(1024).fill(0);
  embedding[0] = 1;
  return {
    ...actual,
    generateEmbedding: async () => ({ ok: true, embedding, provider: "stub", model: "stub", dimension: 1024, latencyMs: 0 }),
  };
});

import { db, memoryEntries, orgConfigs } from "@janusly/db";
import { commitMemory, recallMemory } from "../memoryEntriesRepo";
import { upsertOrgConfig } from "../orgConfigRepo";

const RUN_TAG = `${Date.now()}-${process.pid}`;
const ORG = `it-mem-${RUN_TAG}`;
const priorFlag = process.env.JANUSLY_MEMORY_ENABLED;

beforeAll(async () => {
  process.env.JANUSLY_MEMORY_ENABLED = "true";
  // Two-flag consent: process env above + tenant config below (also opts the
  // `workflow_vector` kind in). upsertOrgConfig clears the org-config cache.
  await upsertOrgConfig({ orgId: ORG, key: "memory.enabled", value: true });
  await upsertOrgConfig({ orgId: ORG, key: "memory.allowedKinds", value: "workflow_vector" });
});

afterAll(async () => {
  await db.delete(memoryEntries).where(eq(memoryEntries.orgId, ORG));
  await db.delete(orgConfigs).where(eq(orgConfigs.orgId, ORG));
  if (priorFlag === undefined) delete process.env.JANUSLY_MEMORY_ENABLED;
  else process.env.JANUSLY_MEMORY_ENABLED = priorFlag;
});

describe("memory commit → recall round-trip (real pgvector)", () => {
  it("commits an entry and recalls it by similarity", async () => {
    const committed = await commitMemory({
      orgId: ORG,
      kind: "workflow_vector",
      content: "the quick brown fox recovered the run",
    });
    expect(committed.ok, JSON.stringify(committed)).toBe(true);

    const recalled = await recallMemory({ orgId: ORG, kind: "workflow_vector", query: "recover the run" });
    expect(recalled.entries.length).toBeGreaterThan(0);
    expect(recalled.entries.some((e) => e.content.includes("quick brown fox"))).toBe(true);
  });

  it("returns no entries when consent is off (fail-closed), never throws", async () => {
    process.env.JANUSLY_MEMORY_ENABLED = "false";
    const recalled = await recallMemory({ orgId: ORG, kind: "workflow_vector", query: "recover the run" });
    expect(recalled.entries).toEqual([]);
    process.env.JANUSLY_MEMORY_ENABLED = "true";
  });
});

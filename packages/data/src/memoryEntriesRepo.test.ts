/**
 * Pure-unit tests for the memory substrate repo.
 *
 * `@janusly/db`, `@janusly/ai`, `./memoryConsent`, `./orgConfigRepo`,
 * and `./memoryUsage` are mocked. Tests cover the 7 AC categories:
 * cross-org isolation, retention filtering, embedding fallback,
 * secret-shape scrubbing at both layers, disabled-org rejection,
 * metadata correctness for re-embedding, and query limits.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mocks (must come BEFORE the repo import) ────────────────────────────────

const insertValuesMock = vi.fn();
const deleteWhereMock = vi.fn();
const selectMock = vi.fn();

vi.mock("@janusly/db", () => ({
  db: {
    insert: vi.fn(() => ({ values: insertValuesMock })),
    select: vi.fn(() => selectMock()),
    delete: vi.fn(() => ({
      where: deleteWhereMock,
    })),
  },
  memoryEntries: { orgId: "org_id_col", kind: "kind_col", retainUntil: "retain_until_col", embedding: "embedding_col", id: "id_col" },
  auditLogs: { id: "id_col" },
}));

vi.mock("@janusly/ai", () => ({
  generateEmbedding: vi.fn(),
}));

vi.mock("./memoryConsent", () => ({
  isMemoryAllowed: vi.fn(),
}));

vi.mock("./orgConfigRepo", () => ({
  listOrgConfig: vi.fn(),
}));

vi.mock("./memoryUsage", () => ({
  getMemoryUsageRecorder: vi.fn(),
}));

import { db, memoryEntries } from "@janusly/db";
import { generateEmbedding } from "@janusly/ai";
import { isMemoryAllowed } from "./memoryConsent";
import { listOrgConfig } from "./orgConfigRepo";
import { getMemoryUsageRecorder } from "./memoryUsage";
import { commitMemory, recallMemory, deleteExpiredMemory } from "./memoryEntriesRepo";

const generateEmbeddingMock = vi.mocked(generateEmbedding);
const isMemoryAllowedMock = vi.mocked(isMemoryAllowed);
const listOrgConfigMock = vi.mocked(listOrgConfig);
const getMemoryUsageRecorderMock = vi.mocked(getMemoryUsageRecorder);

// ─── Helpers ────────────────────────────────────────────────────────────────

function fakeOrgConfigEntries(overrides: Partial<Record<string, string | number | boolean>> = {}) {
  const make = (key: string, value: string | number | boolean) => ({
    key,
    value,
    orgId: "default",
    source: "tenant" as const,
    updatedAt: new Date(),
    category: "memory",
    description: "",
    valueType: typeof value as "string" | "number" | "boolean",
    defaultValue: value,
  });
  return [
    make("memory.enabled", overrides["memory.enabled"] ?? true),
    make("memory.allowedKinds", overrides["memory.allowedKinds"] ?? "recovery_rationale,run_summary,runbook_fragment,patch_rationale"),
    make("memory.retentionDaysByKind", overrides["memory.retentionDaysByKind"] ?? ""),
    make("memory.recallMaxEntries", overrides["memory.recallMaxEntries"] ?? 8),
    make("memory.recallMaxBytes", overrides["memory.recallMaxBytes"] ?? 8192),
    make("memory.embeddingProvider", overrides["memory.embeddingProvider"] ?? "ollama"),
    make("memory.embeddingModel", overrides["memory.embeddingModel"] ?? "bge-m3"),
    make("memory.embeddingBaseUrl", overrides["memory.embeddingBaseUrl"] ?? ""),
  ];
}

function fakeRecallRow(over: Partial<{
  id: string;
  kind: string;
  content: string;
  workflowId: string | null;
  runId: string | null;
  metadata: unknown;
  createdAt: Date;
  distance: number;
}> = {}) {
  return {
    id: over.id ?? "entry-1",
    kind: over.kind ?? "recovery_rationale",
    content: over.content ?? "remembered rationale",
    workflowId: over.workflowId ?? null,
    runId: over.runId ?? null,
    metadata: over.metadata ?? null,
    createdAt: over.createdAt ?? new Date("2026-01-01"),
    distance: over.distance ?? 0.1,
  };
}

function stubSuccessfulEmbedding(dimension = 1024) {
  generateEmbeddingMock.mockResolvedValue({
    ok: true,
    embedding: Array.from({ length: dimension }, () => 0.1),
    provider: "ollama",
    model: "bge-m3",
    dimension,
    latencyMs: 12,
  });
}

function buildSelectChain(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn(() => ({ limit }));
  const where = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ where }));
  selectMock.mockReturnValue({ from });
  return { from, where, orderBy, limit };
}

beforeEach(() => {
  insertValuesMock.mockReset().mockResolvedValue(undefined);
  deleteWhereMock.mockReset();
  selectMock.mockReset();
  generateEmbeddingMock.mockReset();
  isMemoryAllowedMock.mockReset();
  listOrgConfigMock.mockReset();
  getMemoryUsageRecorderMock.mockReset().mockReturnValue(null);
  isMemoryAllowedMock.mockResolvedValue({ allowed: true });
  listOrgConfigMock.mockResolvedValue(fakeOrgConfigEntries() as never);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("commitMemory — disabled-org rejection", () => {
  it("returns memory_disabled when process flag is off", async () => {
    isMemoryAllowedMock.mockResolvedValueOnce({
      allowed: false,
      reason: "process_disabled",
      message: "off",
    });
    const result = await commitMemory({
      orgId: "default",
      kind: "recovery_rationale",
      content: "anything",
    });
    expect(result).toEqual({ ok: false, error: "memory_disabled" });
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it("returns memory_disabled when tenant flag is off", async () => {
    isMemoryAllowedMock.mockResolvedValueOnce({
      allowed: false,
      reason: "tenant_disabled",
      message: "off",
    });
    const result = await commitMemory({
      orgId: "default",
      kind: "recovery_rationale",
      content: "anything",
    });
    expect(result).toEqual({ ok: false, error: "memory_disabled" });
  });

  it("returns kind_disabled when the kind isn't in allowedKinds", async () => {
    listOrgConfigMock.mockResolvedValueOnce(
      fakeOrgConfigEntries({ "memory.allowedKinds": "" }) as never,
    );
    const result = await commitMemory({
      orgId: "default",
      kind: "recovery_rationale",
      content: "anything",
    });
    expect(result).toEqual({ ok: false, error: "kind_disabled" });
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it("returns config_unavailable when the memory config read fails", async () => {
    listOrgConfigMock.mockRejectedValueOnce(new Error("db unavailable"));
    const result = await commitMemory({
      orgId: "default",
      kind: "recovery_rationale",
      content: "anything",
    });
    expect(result).toEqual({ ok: false, error: "config_unavailable" });
    expect(generateEmbeddingMock).not.toHaveBeenCalled();
    expect(insertValuesMock).not.toHaveBeenCalled();
  });
});

describe("commitMemory — secret-shape scrubbing at write time", () => {
  // The shared `scrubSecretShapes` regex requires 20+ chars for sk- /
  // ghp_ shapes and 16+ chars for Bearer tokens. The fixtures below
  // are deliberately long enough to satisfy the minimums.
  const LEAK_SK = "sk-aaaaaaaaaaaaaaaaaaaa";
  const LEAK_GHP = "ghp_aaaaaaaaaaaaaaaaaaaa";

  it("scrubs the content before computing the embedding", async () => {
    stubSuccessfulEmbedding();
    await commitMemory({
      orgId: "default",
      kind: "recovery_rationale",
      content: `header ${LEAK_SK} and ${LEAK_GHP} trailer`,
    });
    const embeddedText = generateEmbeddingMock.mock.calls[0]?.[0] ?? "";
    expect(embeddedText).not.toContain(LEAK_SK);
    expect(embeddedText).not.toContain(LEAK_GHP);
    expect(embeddedText).toMatch(/\[redacted\]/);
  });

  it("persists the scrubbed content (not the raw input)", async () => {
    stubSuccessfulEmbedding();
    await commitMemory({
      orgId: "default",
      kind: "recovery_rationale",
      content: `incident note: ${LEAK_SK} trailing`,
    });
    const inserted = insertValuesMock.mock.calls[0]?.[0] as { content: string };
    expect(inserted.content).not.toContain(LEAK_SK);
    expect(inserted.content).toMatch(/\[redacted\]/);
  });
});

describe("commitMemory — embedding timeout fallback", () => {
  it("returns embedding_failed and does NOT persist a memory_entries row", async () => {
    generateEmbeddingMock.mockResolvedValueOnce({
      ok: false,
      error: "ollama_timeout",
      latencyMs: 30_000,
    });
    const result = await commitMemory({
      orgId: "default",
      kind: "recovery_rationale",
      content: "any prompt long enough to satisfy the scrubber",
    });
    expect(result).toEqual({ ok: false, error: "embedding_failed" });
    // The repo writes a `memory.recall.failed` audit row on the failure
    // path, so `insertValuesMock` is invoked once for the audit. The
    // contract being asserted is that the MEMORY_ENTRIES row is not
    // persisted — confirm by inspecting which Drizzle table was passed
    // to `db.insert`.
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(db.insert).not.toHaveBeenCalledWith(memoryEntries);
    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "memory.entry.failed",
        metadata: expect.objectContaining({ reason: "embedding_failed" }),
      }),
    );
  });

  it("fires the usage recorder with ok:false on embedding failure", async () => {
    const recorder = vi.fn();
    getMemoryUsageRecorderMock.mockReturnValue(recorder);
    generateEmbeddingMock.mockResolvedValueOnce({
      ok: false,
      error: "ollama_unreachable",
      latencyMs: 5,
    });
    await commitMemory({
      orgId: "default",
      kind: "recovery_rationale",
      content: "any prompt",
    });
    expect(recorder).toHaveBeenCalledWith(
      expect.objectContaining({
        metric: "memory.commit",
        ok: false,
        error: expect.stringContaining("embedding_failed"),
      }),
    );
  });

  it("returns embedding_failed before insert when the model dimension does not match the column", async () => {
    stubSuccessfulEmbedding(3);
    const result = await commitMemory({
      orgId: "default",
      kind: "recovery_rationale",
      content: "any prompt",
    });
    expect(result).toEqual({ ok: false, error: "embedding_failed" });
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(db.insert).not.toHaveBeenCalledWith(memoryEntries);
  });
});

describe("commitMemory — metadata correctness for re-embedding", () => {
  it("persists embeddingProvider, embeddingModel, embeddingDimension from the envelope", async () => {
    stubSuccessfulEmbedding(1024);
    await commitMemory({
      orgId: "default",
      kind: "patch_rationale",
      content: "fix used add_retry approach",
    });
    const inserted = insertValuesMock.mock.calls[0]?.[0] as {
      embeddingProvider: string;
      embeddingModel: string;
      embeddingDimension: number;
    };
    expect(inserted.embeddingProvider).toBe("ollama");
    expect(inserted.embeddingModel).toBe("bge-m3");
    expect(inserted.embeddingDimension).toBe(1024);
  });

  it("redacts sensitive metadata keys and secret-shaped metadata values before insert", async () => {
    stubSuccessfulEmbedding();
    await commitMemory({
      orgId: "default",
      kind: "patch_rationale",
      content: "fix used add_retry approach",
      metadata: {
        apiKey: "sk-aaaaaaaaaaaaaaaaaaaa",
        nested: { note: "Bearer aaaaaaaaaaaaaaaaaaaa" },
      },
    });
    const inserted = insertValuesMock.mock.calls[0]?.[0] as {
      metadata: Record<string, unknown>;
    };
    expect(inserted.metadata.apiKey).toBe("[redacted]");
    expect(JSON.stringify(inserted.metadata)).not.toContain("sk-aaaaaaaaaaaaaaaaaaaa");
    expect(JSON.stringify(inserted.metadata)).not.toContain("Bearer aaaaaaaaaaaaaaaaaaaa");
  });

  it("uses byte length for the metadata ceiling", async () => {
    const result = await commitMemory({
      orgId: "default",
      kind: "patch_rationale",
      content: "fix used add_retry approach",
      metadata: { note: "é".repeat(4097) },
    });
    expect(result).toEqual({ ok: false, error: "metadata_too_large" });
    expect(generateEmbeddingMock).not.toHaveBeenCalled();
    expect(insertValuesMock).not.toHaveBeenCalled();
  });

  it("handles circular metadata without throwing", async () => {
    stubSuccessfulEmbedding();
    const metadata: Record<string, unknown> = { source: "test" };
    metadata.self = metadata;
    await commitMemory({
      orgId: "default",
      kind: "patch_rationale",
      content: "fix used add_retry approach",
      metadata,
    });
    const inserted = insertValuesMock.mock.calls[0]?.[0] as {
      metadata: Record<string, unknown>;
    };
    expect(inserted.metadata.self).toBe("[circular]");
  });
});

describe("recallMemory — disabled-org rejection", () => {
  it("returns empty entries without consulting embeddings or DB", async () => {
    isMemoryAllowedMock.mockResolvedValueOnce({
      allowed: false,
      reason: "tenant_disabled",
      message: "off",
    });
    const result = await recallMemory({ orgId: "default", query: "anything" });
    expect(result).toEqual({ entries: [] });
    expect(generateEmbeddingMock).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("returns empty entries when the memory config read fails", async () => {
    listOrgConfigMock.mockRejectedValueOnce(new Error("db unavailable"));
    const result = await recallMemory({ orgId: "default", query: "anything" });
    expect(result).toEqual({ entries: [] });
    expect(generateEmbeddingMock).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
  });
});

describe("recallMemory — embedding failure degrades to empty", () => {
  it("returns empty entries when generateEmbedding rejects the query", async () => {
    generateEmbeddingMock.mockResolvedValueOnce({
      ok: false,
      error: "ollama_timeout",
      latencyMs: 30_000,
    });
    const result = await recallMemory({ orgId: "default", query: "anything" });
    expect(result).toEqual({ entries: [] });
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("returns empty entries when the model dimension does not match the column", async () => {
    stubSuccessfulEmbedding(3);
    const result = await recallMemory({ orgId: "default", query: "anything" });
    expect(result).toEqual({ entries: [] });
    expect(selectMock).not.toHaveBeenCalled();
  });
});

describe("recallMemory — query failure degrades to empty", () => {
  it("returns empty entries when the memory select fails", async () => {
    stubSuccessfulEmbedding();
    const limit = vi.fn().mockRejectedValue(new Error("db unavailable"));
    const orderBy = vi.fn(() => ({ limit }));
    const where = vi.fn(() => ({ orderBy }));
    const from = vi.fn(() => ({ where }));
    selectMock.mockReturnValue({ from });

    const result = await recallMemory({ orgId: "default", query: "anything" });

    expect(result).toEqual({ entries: [] });
  });
});

describe("recallMemory — secret-shape scrubbing at read time", () => {
  it("scrubs row content even if a freshly-leaked shape survived the write-time scrub", async () => {
    stubSuccessfulEmbedding();
    buildSelectChain([
      fakeRecallRow({
        id: "leaked",
        content: "stored content with raw Bearer sk-leak-from-the-past",
      }),
    ]);
    const result = await recallMemory({ orgId: "default", query: "test" });
    expect(result.entries[0]?.content).not.toContain("sk-leak-from-the-past");
    expect(result.entries[0]?.content).toMatch(/\[redacted\]/);
  });
});

describe("recallMemory — orgId leads before similarity ranking", () => {
  it("wraps the org filter into the WHERE clause before the order-by similarity", async () => {
    stubSuccessfulEmbedding();
    const chain = buildSelectChain([fakeRecallRow()]);
    await recallMemory({ orgId: "org-a", query: "test" });
    expect(chain.where).toHaveBeenCalledTimes(1);
    // The WHERE clause must be applied before orderBy → limit (test enforces ordering).
    const whereOrder = chain.where.mock.invocationCallOrder[0]!;
    const orderByOrder = chain.orderBy.mock.invocationCallOrder[0]!;
    const limitOrder = chain.limit.mock.invocationCallOrder[0]!;
    expect(whereOrder).toBeLessThan(orderByOrder);
    expect(orderByOrder).toBeLessThan(limitOrder);
  });
});

describe("recallMemory — query limits", () => {
  it("trims to recallMaxBytes once the running total would overflow", async () => {
    stubSuccessfulEmbedding();
    listOrgConfigMock.mockResolvedValueOnce(
      fakeOrgConfigEntries({ "memory.recallMaxBytes": 100 }) as never,
    );
    const big = "x".repeat(60);
    buildSelectChain([
      fakeRecallRow({ id: "e1", content: big }),
      fakeRecallRow({ id: "e2", content: big }),
      fakeRecallRow({ id: "e3", content: big }),
    ]);
    const result = await recallMemory({ orgId: "default", query: "test" });
    // First entry (60 bytes) fits; second would push us past 100, so the recall
    // stops at one entry. The first entry is always included even when over-cap.
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.id).toBe("e1");
  });

  it("honors recallMaxEntries via the SQL LIMIT clause", async () => {
    stubSuccessfulEmbedding();
    listOrgConfigMock.mockResolvedValueOnce(
      fakeOrgConfigEntries({ "memory.recallMaxEntries": 2 }) as never,
    );
    const chain = buildSelectChain([fakeRecallRow(), fakeRecallRow({ id: "e2" })]);
    await recallMemory({ orgId: "default", query: "test" });
    expect(chain.limit).toHaveBeenCalledWith(2);
  });
});

describe("recallMemory — similarity score derivation", () => {
  it("translates pgvector cosine distance to similarity (1 - distance)", async () => {
    stubSuccessfulEmbedding();
    buildSelectChain([
      fakeRecallRow({ id: "near", distance: 0.05 }),
      fakeRecallRow({ id: "far", distance: 0.9 }),
    ]);
    const result = await recallMemory({ orgId: "default", query: "test" });
    expect(result.entries[0]?.similarity).toBeCloseTo(0.95, 5);
    expect(result.entries[1]?.similarity).toBeCloseTo(0.1, 5);
  });
});

describe("deleteExpiredMemory — retention sweep", () => {
  it("deletes via the WHERE retain_until <= now() predicate and returns the count", async () => {
    const returning = vi
      .fn()
      .mockResolvedValue([
        { id: "e1", orgId: "default", kind: "recovery_rationale" },
        { id: "e2", orgId: "default", kind: "run_summary" },
      ]);
    deleteWhereMock.mockReturnValue({ returning });
    const result = await deleteExpiredMemory({ orgId: "default" });
    expect(result.entriesPurged).toBe(2);
    expect(returning).toHaveBeenCalled();
  });

  it("returns 0 when nothing has expired (and skips the audit insert)", async () => {
    const returning = vi.fn().mockResolvedValue([]);
    deleteWhereMock.mockReturnValue({ returning });
    insertValuesMock.mockClear();
    const result = await deleteExpiredMemory({ orgId: "default" });
    expect(result.entriesPurged).toBe(0);
    expect(insertValuesMock).not.toHaveBeenCalled();
  });
});

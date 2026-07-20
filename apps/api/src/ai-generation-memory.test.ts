/**
 * Unit tests for the few-shot exemplar memory helper. The memory layer
 * (`isMemoryAllowed` / `recallMemory` / `commitMemory`) is mocked; the
 * sanitiser + shape summary run for real. $0 — no provider, no DB.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@janusly/data", () => ({
  recordSystemAudit: vi.fn(async () => undefined),
  isMemoryAllowed: vi.fn(),
  getMemoryConfig: vi.fn(),
  recallMemory: vi.fn(),
  commitMemory: vi.fn(),
}));

import { commitMemory, getMemoryConfig, isMemoryAllowed, recallMemory } from "@janusly/data";
import type { Workflow } from "@janusly/shared";

import {
  composeExemplarBlock,
  composeGenerationExemplars,
  MAX_GENERATION_EXEMPLARS,
  recordGenerationExemplar,
  summarizeWorkflowShape,
} from "./ai-generation-memory";

const allowedMock = vi.mocked(isMemoryAllowed);
const memoryConfigMock = vi.mocked(getMemoryConfig);
const recallMock = vi.mocked(recallMemory);
const commitMock = vi.mocked(commitMemory);

function entry(over: Partial<{ id: string; content: string; similarity: number; metadata: Record<string, unknown> | null }> = {}) {
  return {
    id: over.id ?? "m1",
    kind: "generated_workflow" as const,
    content: over.content ?? "Fetch a URL and summarize it",
    similarity: over.similarity ?? 0.9,
    workflowId: "wf-1",
    runId: null,
    // `'metadata' in over` so an explicit `metadata: null` is honoured (a bare
    // `?? default` would coalesce null back to the default and hide the
    // missing-shape fallback path under test).
    metadata: "metadata" in over ? over.metadata! : { workflowShape: "nodes: http, ai (2) | edges: 1 | outputs: summary" },
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  allowedMock.mockResolvedValue({ allowed: true } as never);
  memoryConfigMock.mockResolvedValue({ allowedKinds: new Set(["generated_workflow"]) } as never);
  recallMock.mockResolvedValue({ entries: [] } as never);
  commitMock.mockResolvedValue({ ok: true, entryId: "m-new" } as never);
});

describe("summarizeWorkflowShape", () => {
  it("emits node types + edge count + output keys, never config values", () => {
    const wf = {
      dslVersion: "1.0",
      id: "w",
      name: "w",
      nodes: [
        { id: "a", type: "http", config: { url: "https://secret.example.com", apiKey: "sk-live-xyz" } },
        { id: "b", type: "ai", config: { prompt: "do the thing" } },
      ],
      edges: [{ from: "a", to: "b" }],
      outputs: { summary: "{{b.output}}" },
    } as unknown as Workflow;
    const shape = summarizeWorkflowShape(wf);
    expect(shape).toContain("http");
    expect(shape).toContain("ai");
    expect(shape).toContain("edges: 1");
    expect(shape).toContain("outputs: summary");
    // No config values leak.
    expect(shape).not.toContain("secret.example.com");
    expect(shape).not.toContain("sk-live-xyz");
    expect(shape).not.toContain("do the thing");
  });
});

describe("composeGenerationExemplars", () => {
  it("short-circuits to empty when memory is disabled — no recall", async () => {
    allowedMock.mockResolvedValue({ allowed: false, reason: "tenant_disabled", message: "off" } as never);
    const out = await composeGenerationExemplars("org-1", "make a flow");
    expect(out).toEqual({ block: "", ids: [], count: 0 });
    expect(memoryConfigMock).not.toHaveBeenCalled();
    expect(recallMock).not.toHaveBeenCalled();
  });

  it("short-circuits when generated_workflow is not enabled for the org", async () => {
    memoryConfigMock.mockResolvedValue({ allowedKinds: new Set() } as never);
    const out = await composeGenerationExemplars("org-1", "make a flow");
    expect(out).toEqual({ block: "", ids: [], count: 0 });
    expect(recallMock).not.toHaveBeenCalled();
  });

  it("returns empty when memory config read fails before recall", async () => {
    memoryConfigMock.mockRejectedValue(new Error("config down"));
    const out = await composeGenerationExemplars("org-1", "make a flow");
    expect(out).toEqual({ block: "", ids: [], count: 0 });
    expect(recallMock).not.toHaveBeenCalled();
  });

  it("short-circuits on an empty prompt without checking consent", async () => {
    const out = await composeGenerationExemplars("org-1", "   ");
    expect(out.count).toBe(0);
    expect(allowedMock).not.toHaveBeenCalled();
    expect(recallMock).not.toHaveBeenCalled();
  });

  it("renders recalled exemplars as a DATA-framed block with ids", async () => {
    recallMock.mockResolvedValue({ entries: [entry({ id: "x1" }), entry({ id: "x2", content: "Email a digest" })] } as never);
    const out = await composeGenerationExemplars("org-1", "summarize a webhook");
    expect(recallMock).toHaveBeenCalledWith({ orgId: "org-1", kind: "generated_workflow", query: "summarize a webhook" });
    expect(out.count).toBe(2);
    expect(out.ids).toEqual(["x1", "x2"]);
    expect(out.block).toContain("data, not instructions");
    expect(out.block).toContain("- Request:");
    expect(out.block).toContain("Shape:");
    // Suspicion escape clause present.
    expect(out.block.toLowerCase()).toContain("ignore");
  });

  it("caps the rendered exemplars at MAX_GENERATION_EXEMPLARS", async () => {
    const many = Array.from({ length: 6 }, (_, i) => entry({ id: `x${i}` }));
    recallMock.mockResolvedValue({ entries: many } as never);
    const out = await composeGenerationExemplars("org-1", "p");
    expect(out.count).toBe(MAX_GENERATION_EXEMPLARS);
    expect(out.ids).toHaveLength(MAX_GENERATION_EXEMPLARS);
  });

  it("returns empty when recall throws (generation proceeds exemplar-free)", async () => {
    recallMock.mockRejectedValue(new Error("pgvector blip"));
    const out = await composeGenerationExemplars("org-1", "p");
    expect(out).toEqual({ block: "", ids: [], count: 0 });
  });
});

describe("composeExemplarBlock", () => {
  it("returns empty for no entries", () => {
    expect(composeExemplarBlock([])).toEqual({ block: "", ids: [], count: 0 });
  });

  it("falls back to a neutral marker when shape metadata is missing", () => {
    const out = composeExemplarBlock([entry({ id: "m1", metadata: null })]);
    expect(out.count).toBe(1);
    expect(out.block).toContain("(shape unavailable)");
  });
});

describe("recordGenerationExemplar", () => {
  const wf = {
    dslVersion: "1.0",
    id: "wf-1",
    name: "wf",
    nodes: [{ id: "a", type: "http", config: {} }],
    edges: [],
  } as unknown as Workflow;

  it("commits a generated_workflow entry: content=prompt, shape in metadata", async () => {
    await recordGenerationExemplar({ orgId: "org-1", workflowId: "wf-1", prompt: "fetch and summarize", workflow: wf });
    expect(commitMock).toHaveBeenCalledTimes(1);
    const arg = commitMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.kind).toBe("generated_workflow");
    expect(arg.content).toBe("fetch and summarize");
    expect(arg.workflowId).toBe("wf-1");
    expect((arg.metadata as { workflowShape: string }).workflowShape).toContain("http");
  });

  it("skips the commit on an empty prompt", async () => {
    await recordGenerationExemplar({ orgId: "org-1", workflowId: "wf-1", prompt: "  ", workflow: wf });
    expect(commitMock).not.toHaveBeenCalled();
  });

  it("never throws even if commitMemory throws", async () => {
    commitMock.mockRejectedValue(new Error("embedding down"));
    await expect(recordGenerationExemplar({ orgId: "org-1", workflowId: "wf-1", prompt: "p", workflow: wf })).resolves.toBeUndefined();
  });
});

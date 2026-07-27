/**
 * Contract tests for bounded `loop` execution.
 *
 * These stay below the worker/runtime layer so concurrency, template safety,
 * failure-budget semantics, sandbox skips, and backward compatibility can be
 * exercised deterministically without Postgres or Redis.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { appendEventMock, executeToolForRunMock, getOrgConfigSnapshotMock, recordValidationWriteSkipMock } = vi.hoisted(() => ({
  appendEventMock: vi.fn(),
  executeToolForRunMock: vi.fn(),
  getOrgConfigSnapshotMock: vi.fn(),
  recordValidationWriteSkipMock: vi.fn(),
}));

vi.mock("./persistence", () => ({ appendEvent: appendEventMock }));
vi.mock("./validation-evidence", () => ({
  recordValidationWriteSkip: recordValidationWriteSkipMock,
}));
vi.mock("@janusly/data", () => ({ getOrgConfigSnapshot: getOrgConfigSnapshotMock }));
vi.mock("./tool-execution", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tool-execution")>();
  return { ...actual, executeToolForRun: executeToolForRunMock };
});

import {
  executeLoop,
  LOOP_FAILURE_SAMPLE_LIMIT,
  LOOP_ITEM_RESULT_MAX_BYTES,
  LOOP_MAX_ITEMS,
  LOOP_RESULT_ITEMS_MAX_BYTES,
  LoopExecutionAbortedError,
  LoopFailureBudgetExceededError,
  LoopItemLimitError,
} from "./loop-executor";

const orgConfig = {
  http: {
    timeoutMs: 5_000,
    maxResponseBytes: 1_000_000,
    maxRedirects: 3,
    streamPreviewBytes: 65_536,
  },
  email: {},
  integrations: {},
  objectstore: {},
};

function context(config: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    nodeId: "batch",
    orgId: "org-1",
    workflowId: "wf-1",
    config,
    context: {},
    redactedValues: [] as string[],
    templatePolicy: "lenient" as const,
    dryRun: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  appendEventMock.mockResolvedValue(undefined);
  recordValidationWriteSkipMock.mockResolvedValue(undefined);
  getOrgConfigSnapshotMock.mockResolvedValue(orgConfig);
  executeToolForRunMock.mockImplementation(async ({ toolInput }) => ({ value: toolInput }));
});

describe("executeLoop", () => {
  it("preserves the legacy map output byte-for-byte when mode is absent", async () => {
    const result = await executeLoop(context({
      items: "alpha,beta",
      mapping: { value: "{{item}}", index: "{{index}}" },
    }));

    expect(result).toEqual({
      status: "completed",
      output: {
        count: 2,
        items: [
          { value: "alpha", index: 0 },
          { value: "beta", index: 1 },
        ],
      },
    });
  });

  it("executes per-item tools with bounded concurrency and stable result ordering", async () => {
    let active = 0;
    let maxActive = 0;
    executeToolForRunMock.mockImplementation(async ({ toolInput }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const value = (toolInput as { value: string }).value;
      await new Promise((resolve) => setTimeout(resolve, value === "a" ? 12 : 2));
      active -= 1;
      return { upper: value.toUpperCase() };
    });

    const result = await executeLoop(context({
      mode: "for_each",
      items: ["a", "b", "c"],
      tool: "text.uppercase",
      input: { value: "{{item}}", position: "{{index}}" },
      concurrency: 2,
      toleratedFailureCount: 0,
    }));

    expect(maxActive).toBe(2);
    expect(result.output.items).toEqual([
      { index: 0, status: "succeeded", result: { upper: "A" } },
      { index: 1, status: "succeeded", result: { upper: "B" } },
      { index: 2, status: "succeeded", result: { upper: "C" } },
    ]);
    expect(result.output).toMatchObject({
      mode: "for_each",
      count: 3,
      succeededCount: 3,
      failedCount: 0,
      skippedCount: 0,
    });
  });

  it("stops dequeuing new items after cooperative timeout cancellation", async () => {
    const controller = new AbortController();
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolveStarted) => {
      executeToolForRunMock.mockImplementation(async () => {
        resolveStarted();
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
        return { ok: true };
      });
    });
    const execution = executeLoop(context({
      mode: "for_each",
      items: ["a", "b", "c"],
      tool: "text.uppercase",
      input: { value: "{{item}}" },
      concurrency: 1,
    }, { signal: controller.signal }));

    await firstStarted;
    controller.abort();
    releaseFirst();

    await expect(execution).rejects.toBeInstanceOf(LoopExecutionAbortedError);
    expect(executeToolForRunMock).toHaveBeenCalledTimes(1);
  });

  it("continues with structured failed-item diagnostics inside the count budget", async () => {
    executeToolForRunMock.mockImplementation(async ({ toolInput }) => {
      const value = (toolInput as { value: string }).value;
      if (value === "bad") throw Object.assign(new Error("invalid payload"), { code: "INVALID_JSON" });
      return { value };
    });

    const result = await executeLoop(context({
      mode: "for_each",
      items: ["ok", "bad", "also-ok"],
      tool: "json.parse",
      input: { value: "{{item}}" },
      concurrency: 3,
      toleratedFailureCount: 1,
    }));

    expect(result.output).toMatchObject({
      succeededCount: 2,
      failedCount: 1,
      failedIndices: [1],
      failures: [{ index: 1, error: { message: "invalid payload", code: "INVALID_JSON" } }],
    });
    expect(appendEventMock).not.toHaveBeenCalledWith(
      "run-1",
      "batch",
      "loop.failure_budget.exceeded",
      expect.anything(),
    );
  });

  it("counts a registered tool's ok=false envelope as an item failure", async () => {
    executeToolForRunMock.mockResolvedValue({
      ok: false,
      error: "upstream rejected the item",
      statusCode: 422,
    });

    const result = await executeLoop(context({
      mode: "for_each",
      items: ["bad"],
      tool: "webhook.send",
      input: { url: "https://example.com", body: "{{item}}" },
      toleratedFailureCount: 1,
    }));

    expect(result.output).toMatchObject({
      succeededCount: 0,
      failedCount: 1,
      failures: [{
        index: 0,
        error: {
          message: "upstream rejected the item",
          code: "TOOL_RETURNED_NOT_OK",
          statusCode: 422,
        },
      }],
    });
  });

  it("marks an exceeded write-side batch as unsafe for whole-node retry", async () => {
    executeToolForRunMock.mockResolvedValue({ ok: false, error: "delivery rejected" });

    const error = await executeLoop(context({
      mode: "for_each",
      items: ["a@example.com"],
      tool: "email.send",
      input: { to: "{{item}}", subject: "Notice", body: "Hello" },
      toleratedFailureCount: 0,
    })).catch((value) => value);

    expect(error).toBeInstanceOf(LoopFailureBudgetExceededError);
    expect(error.writeSide).toBe(true);
  });

  it("bounds individual and aggregate successful outputs without losing item status", async () => {
    executeToolForRunMock.mockImplementation(async ({ toolInput }) => ({
      value: `${(toolInput as { value: number }).value}:${"x".repeat(10_000)}`,
    }));

    const result = await executeLoop(context({
      mode: "for_each",
      items: Array.from({ length: 100 }, (_, index) => index),
      tool: "text.uppercase",
      input: { value: "{{item}}" },
      concurrency: 20,
      toleratedFailureCount: 0,
    }));
    const output = result.output as unknown as {
      resultTruncatedCount: number;
      items: Array<{ status: string }>;
      count: number;
      succeededCount: number;
      failedCount: number;
    };

    expect(output).toMatchObject({
      count: 100,
      succeededCount: 100,
      failedCount: 0,
    });
    expect(output.resultTruncatedCount).toBeGreaterThan(0);
    expect(output.items).toHaveLength(100);
    expect(output.items.every(item => item.status === "succeeded")).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(output.items)).byteLength)
      .toBeLessThan(LOOP_RESULT_ITEMS_MAX_BYTES + LOOP_ITEM_RESULT_MAX_BYTES);
  });

  it("caps failure details while preserving every failed index", async () => {
    executeToolForRunMock.mockRejectedValue(new Error("item failed"));
    const itemCount = LOOP_FAILURE_SAMPLE_LIMIT + 10;

    const result = await executeLoop(context({
      mode: "for_each",
      items: Array.from({ length: itemCount }, (_, index) => index),
      tool: "json.parse",
      input: { value: "{{item}}" },
      toleratedFailureCount: itemCount,
    }));
    const output = result.output as unknown as {
      failedCount: number;
      failureDetailsTruncated: boolean;
      failedIndices: number[];
      failures: unknown[];
    };

    expect(output).toMatchObject({
      failedCount: itemCount,
      failureDetailsTruncated: true,
    });
    expect(output.failedIndices).toHaveLength(itemCount);
    expect(output.failures).toHaveLength(LOOP_FAILURE_SAMPLE_LIMIT);
  });

  it("fails with bounded structured details when the percentage budget is exceeded", async () => {
    executeToolForRunMock.mockImplementation(async ({ toolInput }) => {
      const value = (toolInput as { value: string }).value;
      if (value.startsWith("bad")) throw new Error(`invalid ${value}`);
      return { value };
    });

    const error = await executeLoop(context({
      mode: "for_each",
      items: ["ok", "bad-1", "bad-2", "ok-2"],
      tool: "json.parse",
      input: { value: "{{item}}" },
      concurrency: 2,
      toleratedFailurePercentage: 25,
    })).catch((value) => value);

    expect(error).toBeInstanceOf(LoopFailureBudgetExceededError);
    expect(error).toMatchObject({
      code: "LOOP_FAILURE_BUDGET_EXCEEDED",
      details: {
        count: 4,
        failedCount: 2,
        failedPercentage: 50,
        failedIndices: [1, 2],
      },
    });
    expect(appendEventMock).toHaveBeenCalledWith(
      "run-1",
      "batch",
      "loop.failure_budget.exceeded",
      expect.objectContaining({ failedIndices: [1, 2] }),
    );
  });

  it("permits a failure percentage exactly at the configured boundary", async () => {
    executeToolForRunMock.mockImplementation(async ({ toolInput }) => {
      if ((toolInput as { value: string }).value === "bad") throw new Error("bad");
      return { ok: true };
    });

    await expect(executeLoop(context({
      mode: "for_each",
      items: ["ok-1", "ok-2", "ok-3", "bad"],
      tool: "json.parse",
      input: { value: "{{item}}" },
      toleratedFailurePercentage: 25,
    }))).resolves.toMatchObject({ output: { failedCount: 1, failedPercentage: 25 } });
  });

  it("enforces strict late-bound templates before any item side effect starts", async () => {
    const error = await executeLoop(context({
      mode: "for_each",
      items: [{ name: "one" }, { name: "two" }],
      tool: "slack.post",
      input: { text: "{{item.missing}}" },
      concurrency: 2,
    }, { templatePolicy: "strict" })).catch((value) => value);

    expect(error).toMatchObject({ code: "UNRESOLVED_TEMPLATE_PATH", paths: ["item.missing"] });
    expect(executeToolForRunMock).not.toHaveBeenCalled();
    expect(getOrgConfigSnapshotMock).not.toHaveBeenCalled();
  });

  it("skips every write-side invocation in validation mode", async () => {
    const result = await executeLoop(context({
      mode: "for_each",
      items: ["one", "two"],
      tool: "slack.post",
      input: { channel: "ops", text: "{{item}}", credential: "slack-main" },
      concurrency: 2,
      toleratedFailureCount: 0,
    }, { dryRun: true }));

    expect(executeToolForRunMock).not.toHaveBeenCalled();
    expect(result.output).toMatchObject({
      succeededCount: 0,
      skippedCount: 2,
      failedCount: 0,
      items: [
        { index: 0, status: "skipped", dryRun: true },
        { index: 1, status: "skipped", dryRun: true },
      ],
    });
    expect(recordValidationWriteSkipMock).toHaveBeenCalledWith(
      "run-1",
      "batch",
      "loop.dry_run.skipped",
      { tool: "slack.post", skippedCount: 2, count: 2 },
    );
  });

  it("rejects an item set above the one-node persistence bound", async () => {
    const error = await executeLoop(context({
      mode: "for_each",
      items: Array.from({ length: LOOP_MAX_ITEMS + 1 }, (_, index) => index),
      tool: "text.uppercase",
      input: { value: "{{item}}" },
    })).catch((value) => value);

    expect(error).toBeInstanceOf(LoopItemLimitError);
    expect(error).toMatchObject({
      code: "LOOP_ITEM_LIMIT_EXCEEDED",
      details: { count: LOOP_MAX_ITEMS + 1, maxItems: LOOP_MAX_ITEMS },
    });
    expect(executeToolForRunMock).not.toHaveBeenCalled();
  });
});

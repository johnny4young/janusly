/**
 * Bounded execution modes for the workflow `loop` node.
 *
 * Legacy `map` mode remains a pure per-item template projection. `for_each`
 * renders every item input before side effects begin, then invokes one
 * registered tool per item through an ordered worker pool. The node owns the
 * concurrency; it does not add another queue/runtime primitive.
 */

import { getOrgConfigSnapshot } from "@janusly/data";
import { appendEvent } from "./persistence";
import { recordValidationWriteSkip } from "./validation-evidence";
import { safePersistPayload } from "./safe-persist";
import {
  enforceLateBoundTemplatePolicy,
  mergeLateBoundRedactions,
} from "./late-bound-template";
import {
  mapInput,
  redactError,
  renderTemplateWithRedactions,
} from "./template";
import {
  dryRunToolSkipPayload,
  executeToolForRun,
  isToolInvocationWriteSide,
  withHttpToolDefaults,
} from "./tool-execution";

export const LOOP_DEFAULT_CONCURRENCY = 4;
export const LOOP_MAX_CONCURRENCY = 20;
export const LOOP_MAX_ITEMS = 1_000;
export const LOOP_ITEM_RESULT_MAX_BYTES = 64_000;
export const LOOP_RESULT_ITEMS_MAX_BYTES = 700_000;
export const LOOP_FAILURE_SAMPLE_LIMIT = 50;

const LOOP_ERROR_MESSAGE_MAX_CHARS = 300;
const LOOP_ERROR_METADATA_MAX_CHARS = 120;

type LoopContext = {
  runId: string;
  nodeId: string;
  orgId: string;
  workflowId: string | null;
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  redactedValues?: string[];
  templatePolicy?: "lenient" | "strict";
  dryRun?: boolean;
  signal?: AbortSignal;
};

type LoopItemError = {
  message: string;
  name?: string;
  code?: string;
  statusCode?: number;
};

type LoopItemResult =
  | {
    index: number;
    status: "succeeded";
    result: Record<string, unknown>;
    resultTruncated?: true;
  }
  | { index: number; status: "skipped"; dryRun: true }
  | {
    index: number;
    status: "failed";
    error: LoopItemError;
    errorTruncated?: true;
  };

type LoopFailureDetails = {
  tool: string;
  count: number;
  succeededCount: number;
  skippedCount: number;
  failedCount: number;
  failedPercentage: number;
  failedIndices: number[];
  failures: Array<{ index: number; error: LoopItemError }>;
  failureDetailsTruncated: boolean;
  resultTruncatedCount: number;
  toleratedFailureCount?: number;
  toleratedFailurePercentage?: number;
};

/** Structured terminal error persisted into retry events and the DLQ. */
export class LoopFailureBudgetExceededError extends Error {
  readonly code = "LOOP_FAILURE_BUDGET_EXCEEDED";
  readonly details: LoopFailureDetails;
  readonly writeSide: boolean;

  constructor(details: LoopFailureDetails, writeSide = false) {
    super(`Loop failure budget exceeded: ${details.failedCount} of ${details.count} items failed`);
    this.name = "LoopFailureBudgetExceededError";
    this.details = details;
    this.writeSide = writeSide;
  }
}

/** Cooperative stop used after the enclosing node timeout wins its race. */
export class LoopExecutionAbortedError extends Error {
  readonly code = "LOOP_EXECUTION_ABORTED";

  constructor() {
    super("Loop execution aborted");
    this.name = "LoopExecutionAbortedError";
  }
}

/** Stable error for inputs too large to execute and persist safely in one node. */
export class LoopItemLimitError extends Error {
  readonly code = "LOOP_ITEM_LIMIT_EXCEEDED";
  readonly details: { count: number; maxItems: number };

  constructor(count: number) {
    super(`Loop contains ${count} items; maximum is ${LOOP_MAX_ITEMS}`);
    this.name = "LoopItemLimitError";
    this.details = { count, maxItems: LOOP_MAX_ITEMS };
  }
}

function normalizeItems(rawItems: unknown): unknown[] {
  if (Array.isArray(rawItems)) return rawItems;
  if (typeof rawItems !== "string") return [];
  return rawItems.split(",").map((item) => item.trim()).filter(Boolean);
}

function boundedText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

function serializeItemError(error: unknown, redactedValues: string[]): LoopItemError {
  const redacted = redactError(error, redactedValues);
  if (redacted instanceof Error) {
    const candidate = redacted as Error & { code?: unknown; statusCode?: unknown };
    return {
      message: boundedText(redacted.message, LOOP_ERROR_MESSAGE_MAX_CHARS),
      name: redacted.name
        ? boundedText(redacted.name, LOOP_ERROR_METADATA_MAX_CHARS)
        : undefined,
      code: typeof candidate.code === "string"
        ? boundedText(candidate.code, LOOP_ERROR_METADATA_MAX_CHARS)
        : undefined,
      statusCode: typeof candidate.statusCode === "number" ? candidate.statusCode : undefined,
    };
  }
  return {
    message: typeof redacted === "string"
      ? boundedText(redacted, LOOP_ERROR_MESSAGE_MAX_CHARS)
      : "Tool execution failed",
  };
}

function serializeFailedEnvelope(
  result: Record<string, unknown>,
  redactedValues: string[],
): LoopItemError {
  const rawError = typeof result.error === "string" ? result.error : "Tool returned ok=false";
  const error = Object.assign(new Error(rawError), {
    code: typeof result.code === "string" ? result.code : "TOOL_RETURNED_NOT_OK",
    statusCode: typeof result.statusCode === "number" ? result.statusCode : undefined,
  });
  return serializeItemError(error, redactedValues);
}

function isTruncatedPayload(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (value as Record<string, unknown>).__truncated === true;
}

function boundToolResult(
  result: Record<string, unknown>,
  redactedValues: string[],
): Pick<Extract<LoopItemResult, { status: "succeeded" }>, "result" | "resultTruncated"> {
  const bounded = safePersistPayload(result, {
    maxBytes: LOOP_ITEM_RESULT_MAX_BYTES,
    redactedValues,
  }) as Record<string, unknown>;
  return isTruncatedPayload(bounded)
    ? { result: bounded, resultTruncated: true }
    : { result: bounded };
}

function boundAggregateResults(results: LoopItemResult[]): LoopItemResult[] {
  const encoder = new TextEncoder();
  let usedBytes = 2;
  return results.map((item) => {
    const serialized = JSON.stringify(item);
    const candidateBytes = serialized ? encoder.encode(serialized).byteLength + 1 : 1;
    if (usedBytes + candidateBytes <= LOOP_RESULT_ITEMS_MAX_BYTES) {
      usedBytes += candidateBytes;
      return item;
    }
    const bounded: LoopItemResult = item.status === "failed"
      ? {
        index: item.index,
        status: "failed",
        error: {
          message: "Failure details omitted from the per-item list; inspect the failure sample",
          code: "LOOP_RESULT_BUDGET_EXCEEDED",
        },
        errorTruncated: true,
      }
      : item.status === "succeeded"
        ? {
          index: item.index,
          status: "succeeded",
          result: {
            __truncated: true,
            reason: "loop_result_budget_exceeded",
          },
          resultTruncated: true,
        }
        : item;
    usedBytes += encoder.encode(JSON.stringify(bounded)).byteLength + 1;
    return bounded;
  });
}

async function mapConcurrentOrdered<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      if (signal?.aborted) break;
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index] as T, index);
    }
  }));
  if (signal?.aborted) throw new LoopExecutionAbortedError();
  return results;
}

function failureBudgetExceeded(
  failedCount: number,
  totalCount: number,
  toleratedFailureCount: number | undefined,
  toleratedFailurePercentage: number | undefined,
): boolean {
  if (toleratedFailureCount === undefined && toleratedFailurePercentage === undefined) {
    return failedCount > 0;
  }
  if (toleratedFailureCount !== undefined && failedCount > toleratedFailureCount) return true;
  const failedPercentage = totalCount === 0 ? 0 : (failedCount / totalCount) * 100;
  return toleratedFailurePercentage !== undefined && failedPercentage > toleratedFailurePercentage;
}

/** Conservative timeout/replay classification for a `for_each` loop. */
export function isForEachLoopWriteSide(config: Record<string, unknown>): boolean {
  if (config.mode !== "for_each") return false;
  return isToolInvocationWriteSide(config.tool, config.input);
}

async function executeMapLoop(ctx: LoopContext, items: unknown[]) {
  const unresolvedPaths = new Set<string>();
  const lateBoundRedactions = new Set<string>();
  const results = items.map((item, index) => {
    const mapped = renderTemplateWithRedactions(
      ctx.config.mapping ?? { item: "{{item}}", index: "{{index}}" },
      { context: ctx.context, inputs: ctx.config, item, index },
    );
    for (const path of mapped.unresolvedPaths) unresolvedPaths.add(path);
    for (const value of mapped.redactedValues) lateBoundRedactions.add(value);
    return mapped.rendered;
  });
  mergeLateBoundRedactions(ctx, Array.from(lateBoundRedactions));
  await enforceLateBoundTemplatePolicy(ctx, Array.from(unresolvedPaths));
  await appendEvent(ctx.runId, ctx.nodeId, "loop.completed", { count: results.length, items: results });
  return { status: "completed" as const, output: { count: results.length, items: results } };
}

async function executeForEachLoop(ctx: LoopContext, items: unknown[]) {
  const tool = String(ctx.config.tool ?? "");
  const concurrency = Number(ctx.config.concurrency ?? LOOP_DEFAULT_CONCURRENCY);
  const toleratedFailureCount = typeof ctx.config.toleratedFailureCount === "number"
    ? ctx.config.toleratedFailureCount
    : undefined;
  const toleratedFailurePercentage = typeof ctx.config.toleratedFailurePercentage === "number"
    ? ctx.config.toleratedFailurePercentage
    : undefined;

  // Resolve every per-item template before starting any side effect. Strict
  // mode therefore fails the entire node without partially processing a batch.
  const unresolvedPaths = new Set<string>();
  const lateBoundRedactions = new Set<string>();
  const renderedInputs = items.map((item, index) => {
    const mapped = renderTemplateWithRedactions(
      ctx.config.input ?? {},
      { context: ctx.context, inputs: ctx.config, item, index },
    );
    for (const path of mapped.unresolvedPaths) unresolvedPaths.add(path);
    for (const value of mapped.redactedValues) lateBoundRedactions.add(value);
    return mapped.rendered;
  });
  mergeLateBoundRedactions(ctx, Array.from(lateBoundRedactions));
  await enforceLateBoundTemplatePolicy(ctx, Array.from(unresolvedPaths));

  await appendEvent(ctx.runId, ctx.nodeId, "loop.for_each.started", {
    tool,
    count: items.length,
    concurrency,
    toleratedFailureCount,
    toleratedFailurePercentage,
  });

  const orgConfig = await getOrgConfigSnapshot(ctx.orgId);
  const redactedValues = ctx.redactedValues ?? [];
  const rawResults = await mapConcurrentOrdered(renderedInputs, concurrency, async (renderedInput, index): Promise<LoopItemResult> => {
    const toolInput = withHttpToolDefaults(tool, renderedInput, orgConfig);
    const dryRunSkip = ctx.dryRun ? dryRunToolSkipPayload(tool, toolInput) : null;
    if (dryRunSkip) return { index, status: "skipped", dryRun: true };
    try {
      const result = await executeToolForRun({
        tool,
        toolInput,
        context: ctx.context,
        orgConfig,
        orgId: ctx.orgId,
        runId: ctx.runId,
        nodeId: ctx.nodeId,
        workflowId: ctx.workflowId ?? undefined,
      });
      if (result.ok === false) {
        return { index, status: "failed", error: serializeFailedEnvelope(result, redactedValues) };
      }
      return { index, status: "succeeded", ...boundToolResult(result, redactedValues) };
    } catch (error) {
      return { index, status: "failed", error: serializeItemError(error, redactedValues) };
    }
  }, ctx.signal);
  const results = boundAggregateResults(rawResults);

  const allFailures = rawResults
    .filter((item): item is Extract<LoopItemResult, { status: "failed" }> => item.status === "failed")
    .map(({ index, error }) => ({ index, error }));
  const failures = allFailures.slice(0, LOOP_FAILURE_SAMPLE_LIMIT);
  const succeededCount = rawResults.filter((item) => item.status === "succeeded").length;
  const skippedCount = rawResults.filter((item) => item.status === "skipped").length;
  if (skippedCount > 0) {
    await recordValidationWriteSkip(
      ctx.runId,
      ctx.nodeId,
      "loop.dry_run.skipped",
      { tool, skippedCount, count: items.length },
    );
  }
  const failedCount = allFailures.length;
  const failedPercentage = items.length === 0 ? 0 : (failedCount / items.length) * 100;
  const resultTruncatedCount = results.filter(
    (item) => item.status === "succeeded" && item.resultTruncated,
  ).length;
  const details: LoopFailureDetails = {
    tool,
    count: items.length,
    succeededCount,
    skippedCount,
    failedCount,
    failedPercentage,
    failedIndices: allFailures.map((item) => item.index),
    failures,
    failureDetailsTruncated: allFailures.length > failures.length,
    resultTruncatedCount,
    toleratedFailureCount,
    toleratedFailurePercentage,
  };

  if (failureBudgetExceeded(
    failedCount,
    items.length,
    toleratedFailureCount,
    toleratedFailurePercentage,
  )) {
    await appendEvent(ctx.runId, ctx.nodeId, "loop.failure_budget.exceeded", details);
    const invokedWriteSide = !ctx.dryRun
      && renderedInputs.some((input) => isToolInvocationWriteSide(tool, input));
    throw new LoopFailureBudgetExceededError(details, invokedWriteSide);
  }

  await appendEvent(ctx.runId, ctx.nodeId, "loop.completed", {
    mode: "for_each",
    ...details,
  });
  return {
    status: "completed" as const,
    output: {
      mode: "for_each",
      ...details,
      items: results,
    },
  };
}

/** Execute one loop node while preserving the legacy map contract by default. */
export async function executeLoop(ctx: LoopContext) {
  const rawItems = mapInput(ctx.config.items, { context: ctx.context, inputs: ctx.config });
  const items = normalizeItems(rawItems);
  if (items.length > LOOP_MAX_ITEMS) throw new LoopItemLimitError(items.length);
  return ctx.config.mode === "for_each"
    ? executeForEachLoop(ctx, items)
    : executeMapLoop(ctx, items);
}

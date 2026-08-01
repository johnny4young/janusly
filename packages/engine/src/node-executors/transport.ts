/** HTTP, mapping, loop, and registered-tool node executors. */

import { getOrgConfigSnapshot } from "@janusly/data";

import { HttpResponseError } from "../core/http-error";
import { evaluateExpression } from "../expression";
import { consumeStreamToPreview, fetchHttpTarget } from "../http-policy";
import { projectHttpJson } from "../http-json";
import { executeLoop, isForEachLoopWriteSide } from "../loop-executor";
import { appendEvent } from "../persistence";
import { mapInput } from "../template";
import {
  dryRunToolSkipPayload,
  executeToolForRun,
  isToolInvocationWriteSide,
  SAFE_HTTP_METHODS,
  withHttpToolDefaults,
} from "../tool-execution";
import { recordValidationWriteSkip } from "../validation-evidence";
import type { NodeExecutorMap } from "./types";

/**
 * True when a node could commit an external side effect — a non-safe HTTP
 * method or a `writeSide` tool. Same taxonomy the sandbox uses to dry-run-skip
 * write-side actions; reused by `execute-node.ts` to flag a `NODE_TIMEOUT`
 * whose executor may have partially completed its effect. Conservative:
 * node types whose write-side-ness isn't statically known (agent tool calls,
 * subworkflows) return `false` here — those loops carry their own timeouts.
 */
export function isWriteSideNode(node: {
  type: string;
  config?: Record<string, unknown>;
}): boolean {
  if (node.type === "http") {
    return !SAFE_HTTP_METHODS.has(String(node.config?.method ?? "GET").toUpperCase());
  }
  if (node.type === "tool") {
    return isToolInvocationWriteSide(node.config?.tool, node.config?.input);
  }
  if (node.type === "loop") {
    return isForEachLoopWriteSide(node.config ?? {});
  }
  return false;
}

/** A typed failed tool envelope promoted into the runtime failure path. */
export class ToolResultPolicyError extends Error {
  readonly code = "TOOL_RESULT_NOT_OK";
  readonly statusCode?: number;
  readonly details: Record<string, unknown>;
  readonly writeSide: boolean;

  constructor(tool: string, result: Record<string, unknown>, writeSide: boolean) {
    const reason = typeof result.error === "string" && result.error.trim()
      ? result.error.trim()
      : `${tool} returned ok=false`;
    super(reason);
    this.name = "ToolResultPolicyError";
    this.statusCode = typeof result.statusCode === "number" ? result.statusCode : undefined;
    this.details = {
      tool,
      ok: false,
      ...(this.statusCode !== undefined ? { statusCode: this.statusCode } : {}),
      ...(typeof result.provider === "string" ? { provider: result.provider } : {}),
    };
    // Without a provider receipt proving rejection-before-effect, a failed
    // write envelope is ambiguous. Suppress blind whole-node retries; an
    // operator can use exact-node recovery after inspecting the evidence.
    this.writeSide = writeSide;
  }
}

export const transportNodeExecutors = {
  http: async (ctx) => {
    const { url, method, headers, body, timeoutMs, maxResponseBytes, maxRedirects, bodyMode, streamPreviewBytes } = ctx.config;
    const resolvedMethod = (method ?? "GET").toUpperCase();

    // In sandbox/validation mode, skip non-safe methods so the validation
    // run can't double-charge an external API or insert a duplicate row.
    // Read-side methods (GET / HEAD / OPTIONS) still execute — they give
    // the validation real signal without mutating external state.
    if (ctx.dryRun && !SAFE_HTTP_METHODS.has(resolvedMethod)) {
      await recordValidationWriteSkip(ctx.runId, ctx.nodeId, "node.dry_run.skipped", {
        reason: "write-side HTTP method skipped in validation mode",
        method: resolvedMethod,
        url,
      });
      return { status: "completed", output: { statusCode: 0, ok: true, body: null, dryRun: true } };
    }

    const orgConfig = await getOrgConfigSnapshot(ctx.orgId);
    const resolvedTimeoutMs = typeof timeoutMs === "number" ? timeoutMs : orgConfig.http.timeoutMs;
    const resolvedMaxBytes = typeof maxResponseBytes === "number" ? maxResponseBytes : orgConfig.http.maxResponseBytes;
    const resolvedMaxRedirects = typeof maxRedirects === "number" ? maxRedirects : orgConfig.http.maxRedirects;
    const serializedBody = body === undefined ? undefined : JSON.stringify(body);

    // Streaming opt-in: the body comes back as a ReadableStream the executor
    // immediately consumes into a bounded preview before returning. The
    // persisted output shape is a JSON-safe `{ body, streamed, streamedBytes,
    // streamTruncated }` so downstream nodes / templates / persistence see
    // a string preview, not a live stream.
    if (bodyMode === "stream") {
      const previewCap = typeof streamPreviewBytes === "number" && Number.isFinite(streamPreviewBytes)
        ? Math.max(1024, Math.min(streamPreviewBytes, 1_048_576))
        : orgConfig.http.streamPreviewBytes;
      const streaming = await fetchHttpTarget(url, {
        method: resolvedMethod,
        headers: headers as HeadersInit | undefined,
        body: serializedBody,
        timeoutMs: resolvedTimeoutMs,
        maxResponseBytes: resolvedMaxBytes,
        maxRedirects: resolvedMaxRedirects,
        bodyMode: "stream",
      });
      if (!streaming.ok) {
        // Drain the stream so the socket releases — `streamBoundedBody`'s
        // cancel path aborts the shared controller cleanly.
        try { await streaming.body.cancel(); } catch { /* best effort */ }
        throw new HttpResponseError(streaming.statusCode);
      }
      const { preview, originalBytes, truncated } = await consumeStreamToPreview(streaming.body, previewCap);
      return {
        status: "completed",
        output: {
          statusCode: streaming.statusCode,
          ok: streaming.ok,
          body: preview,
          streamed: true,
          streamedBytes: originalBytes,
          streamTruncated: truncated,
        },
      };
    }

    const result = await fetchHttpTarget(url, {
      method: resolvedMethod,
      headers: headers as HeadersInit | undefined,
      body: serializedBody,
      // Optional bounds — nodes that fetch large payloads or call slow APIs
      // pass these through; otherwise tenant/runtime defaults apply.
      timeoutMs: resolvedTimeoutMs,
      maxResponseBytes: resolvedMaxBytes,
      maxRedirects: resolvedMaxRedirects,
    });

    if (!result.ok) throw new HttpResponseError(result.statusCode);
    return {
      status: "completed",
      output: {
        statusCode: result.statusCode,
        ok: result.ok,
        body: result.body,
        ...projectHttpJson(result.body, result.headers),
      },
    };
  },

  condition: async (ctx) => {
    const { expression } = ctx.config;
    const result = evaluateExpression(expression, { context: ctx.context, inputs: ctx.config });
    return { status: "completed", output: { result } };
  },

  transform: async (ctx) => {
    const output = mapInput(ctx.config.mapping, { context: ctx.context, inputs: ctx.config });
    return { status: "completed", output: output as Record<string, unknown> };
  },

  loop: executeLoop,

  tool: async (ctx) => {
    const { tool, input, resultPolicy = "envelope" } = ctx.config;
    const mappedInput = mapInput(input, { context: ctx.context, inputs: ctx.config });
    // One cached snapshot feeds every tool node. Keeping a name allowlist
    // here let newly registered tools (for example pdf.generate) silently
    // fall back to process defaults instead of their tenant configuration.
    const orgConfig = await getOrgConfigSnapshot(ctx.orgId);
    const toolInput = tool === "http.request"
      ? withHttpToolDefaults(tool, mappedInput, orgConfig)
      : mappedInput;

    // In sandbox/validation mode, skip write-side tool invocations.
    // For `http.request` the write-side intent depends on the method —
    // safe methods (GET / HEAD / OPTIONS) still execute so the validation
    // run can read state without mutating it; non-safe methods are
    // skipped to avoid double-charging external APIs.
    const dryRunSkip = ctx.dryRun
      ? dryRunToolSkipPayload(tool, toolInput, ctx.validationEffectMode)
      : null;
    if (dryRunSkip) {
      await recordValidationWriteSkip(
        ctx.runId,
        ctx.nodeId,
        "tool.dry_run.skipped",
        dryRunSkip,
      );
      return { status: "completed", output: { tool, dryRun: true, skipped: true } };
    }

    await appendEvent(ctx.runId, ctx.nodeId, "tool.started", { tool, input: toolInput });
    const result = await executeToolForRun({
      tool,
      toolInput,
      context: ctx.context,
      orgConfig,
      orgId: ctx.orgId,
      runId: ctx.runId,
      nodeId: ctx.nodeId,
      workflowId: ctx.workflowId ?? undefined,
      validationEffectMode: ctx.validationEffectMode,
    });
    if (resultPolicy === "require_ok" && result.ok === false) {
      await appendEvent(ctx.runId, ctx.nodeId, "tool.failed", { tool, result });
      throw new ToolResultPolicyError(
        tool,
        result,
        isToolInvocationWriteSide(tool, toolInput),
      );
    }
    await appendEvent(ctx.runId, ctx.nodeId, "tool.completed", { tool, result });
    return { status: "completed", output: { tool, result } };
  },

} satisfies Pick<
  NodeExecutorMap,
  "http" | "condition" | "transform" | "loop" | "tool"
>;

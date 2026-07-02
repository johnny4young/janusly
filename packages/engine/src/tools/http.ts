/**
 * `http.request` tool — SSRF-gated outbound HTTP for `agent`/`tool` nodes.
 *
 * Used by: `packages/engine/src/tool-registry.ts` (spreads `httpTools` into
 * the registered `tools` object).
 */

import { z } from "zod";
import { consumeStreamToPreview, fetchHttpTarget } from "../http-policy";
import { defineTool, envPositiveInt } from "./tool-types";

const httpRequestInput = z.object({
  url: z.string().min(1),
  method: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
  // Optional bounds — total request budget in ms, max decoded body size in
  // bytes, max redirect chain length. Defaults (30000 / 1_000_000 / 5) apply
  // when omitted; recipes that legitimately need larger payloads or slower
  // upstreams opt in per call.
  timeoutMs: z.number().int().min(1).optional(),
  maxResponseBytes: z.number().int().min(1).optional(),
  maxRedirects: z.number().int().min(0).optional(),
  /**
   * Body handling. `"buffer"` (default) returns the decoded response as a
   * `body: string` capped by `maxResponseBytes`. `"stream"` opts the call
   * into the streaming primitive — the tool wrapper internally consumes
   * the stream into a bounded preview before returning, so the persisted
   * tool output stays JSON-safe. The byte cap still applies (the
   * underlying stream aborts at the cap), and `streamPreviewBytes` controls
   * how much of the response the wrapper captures into the persisted
   * preview (default tenant config).
   */
  bodyMode: z.enum(["buffer", "stream"]).optional(),
  /** Preview cap in bytes when `bodyMode: "stream"`. Range 1024..1048576, falls back to the tenant's `http.streamPreviewBytes` default when omitted. */
  streamPreviewBytes: z.number().int().min(1_024).max(1_048_576).optional(),
});
const httpRequestOutput = z.object({
  statusCode: z.number(),
  ok: z.boolean(),
  body: z.string(),
  /** True iff the call ran with `bodyMode: "stream"`; `body` is then a preview, not the full response. */
  streamed: z.boolean().optional(),
  /** Total bytes consumed from the upstream stream (capped by `maxResponseBytes`). */
  streamedBytes: z.number().optional(),
  /** True iff `streamedBytes > streamPreviewBytes` (i.e. `body` is a truncated slice). */
  streamTruncated: z.boolean().optional(),
});

export const httpTools = {
  /**
   * Invariant (AGENTS.md "HTTP/SSRF"): `http.request` must use
   * `fetchHttpTarget`, whose pinned undici Agent prevents DNS rebinding.
   * A direct `fetch()` bypasses SSRF protection for untrusted URLs.
   */
  "http.request": defineTool({
    name: "http.request",
    description: "Make an HTTP request to an external API.",
    inputSchema: httpRequestInput,
    outputSchema: httpRequestOutput,
    inputExample: { url: "https://example.com", method: "GET" },
    writeSide: true,
    async execute(input) {
      if (input.bodyMode === "stream") {
        const previewCap = input.streamPreviewBytes
          ?? envPositiveInt("JANUSLY_HTTP_STREAM_PREVIEW_BYTES", 65_536);
        const streaming = await fetchHttpTarget(input.url, {
          method: input.method ?? "GET",
          headers: input.headers,
          body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
          timeoutMs: input.timeoutMs,
          maxResponseBytes: input.maxResponseBytes,
          maxRedirects: input.maxRedirects,
          bodyMode: "stream",
        });
        // Always consume the stream — the byte cap fires inside the stream
        // regardless of whether the caller reads it, so draining here keeps
        // the cap-exceeded error reachable AND avoids leaking a live
        // ReadableStream out of the tool's JSON-safe envelope.
        const { preview, originalBytes, truncated } = await consumeStreamToPreview(streaming.body, previewCap);
        return {
          statusCode: streaming.statusCode,
          ok: streaming.ok,
          body: preview,
          streamed: true,
          streamedBytes: originalBytes,
          streamTruncated: truncated,
        };
      }
      const result = await fetchHttpTarget(input.url, {
        method: input.method ?? "GET",
        headers: input.headers,
        body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
        timeoutMs: input.timeoutMs,
        maxResponseBytes: input.maxResponseBytes,
        maxRedirects: input.maxRedirects,
      });
      return { statusCode: result.statusCode, ok: result.ok, body: result.body };
    },
  }),
};

/**
 * CSV tools (`csv.parse` / `.stringify` / `.filter` / `.fetch`), including the
 * streaming `csv.fetch` variant that rides the SSRF-gated HTTP primitive.
 *
 * Used by: `packages/engine/src/tool-registry.ts` (spreads `csvTools`).
 */

import { z } from "zod";
import { scrubSecretShapes } from "@janusly/shared/src/error-signature";
import { fetchHttpTarget } from "../http-policy";
import { streamCsvSummary } from "../csv-stream";
import { filterCsv, parseCsv, stringifyCsv } from "../csv";
import { defineTool } from "./tool-types";

const csvCell = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const csvObjectRows = z.array(z.record(z.string(), csvCell));
const csvArrayRows = z.array(z.array(csvCell));

const csvParseInput = z.object({
  value: z.string(),
  hasHeader: z.boolean().optional(),
});
const csvParseOutput = z.object({ rows: z.unknown() });

const csvStringifyInput = z.object({
  rows: z.union([csvObjectRows, csvArrayRows]),
  header: z.array(z.string()).optional(),
}).superRefine((input, ctx) => {
  if (input.rows.length === 0) return;
  const rowsAreArrays = Array.isArray(input.rows[0]);
  if (rowsAreArrays && input.header !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["header"],
      message: "header is only valid with object rows",
    });
  }
  if (!rowsAreArrays && input.header === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["header"],
      message: "header is required when rows are objects",
    });
  }
});
const csvStringifyOutput = z.object({ value: z.string() });

const csvFilterInput = z.object({
  rows: z.array(z.record(z.string(), z.string())),
  where: z.record(z.string(), z.string()),
});
const csvFilterOutput = z.object({ rows: z.array(z.record(z.string(), z.string())) });

// csv.fetch — streaming variant. Fetches a CSV URL via the streaming
// HTTP primitive, consumes the body row-by-row, applies an optional
// exact-match filter, returns a bounded summary (counts + sample). The
// shared `maxResponseBytes` cap on the upstream stream still applies —
// when hit, the partial sample + counts ride through with
// `streamTruncated: true` so the operator sees what got through.
const csvFetchInput = z.object({
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  /** Max number of matched rows to retain in the response sample. Default 50, hard cap 500 (memory bound). */
  sampleRows: z.number().int().min(1).max(500).optional(),
  /** Optional exact-match WHERE clause; same shape `csv.filter` already uses. */
  filter: z.record(z.string(), z.string()).optional(),
  /** Max bytes pulled from the upstream stream. Default 10 MB; hard cap 50 MB. The shared `fetchHttpTarget` cap fires at this boundary. */
  maxBytes: z.number().int().min(1_024).max(52_428_800).optional(),
  /** Total HTTP timeout budget in ms. Range 1000..120000. */
  timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  /** Max redirect chain length. 0..5. */
  maxRedirects: z.number().int().min(0).max(5).optional(),
});
const csvFetchOutput = z.object({
  ok: z.boolean(),
  /** HTTP status from the upstream response. `0` when the call never opened (SSRF / DNS / cap pre-check). */
  statusCode: z.number().int().nonnegative(),
  /** Total data rows seen (excludes the header row). Includes filtered-out + malformed. */
  totalRows: z.number().int().nonnegative(),
  /** Rows that passed the filter (or `=== totalRows` when no filter). Excludes malformed. */
  matchedRows: z.number().int().nonnegative(),
  /** First `min(sampleRows, matchedRows)` matched rows, keyed by header. */
  sampleRows: z.array(z.record(z.string(), z.string())),
  /** Header tokens in upstream order. `[]` when the stream produced zero rows. */
  headers: z.array(z.string()),
  /** Total bytes pulled from the upstream stream (capped by `maxBytes`). */
  streamedBytes: z.number().int().nonnegative(),
  /**
   * True iff the stream OPENED and then aborted before clean end (byte
   * cap exceeded mid-stream, decoder error, network blip). False on
   * pre-stream rejection paths (SSRF / DNS pin / Content-Length pre-check)
   * — those return `ok: false` with `streamTruncated: false` because no
   * stream was ever opened. Downstream `condition` nodes that need to
   * distinguish "rejected before open" from "aborted mid-flight" should
   * branch on `(ok === false && streamedBytes > 0)` for the mid-flight
   * case, or `(ok === false && statusCode === 0)` for pre-stream.
   */
  streamTruncated: z.boolean(),
  /** Rows whose column count didn't match the header. Counted toward totalRows, not matchedRows. */
  malformedRows: z.number().int().nonnegative(),
  /** Present iff `ok: false`. Generic message; never echoes the upstream URL. */
  error: z.string().optional(),
});

export const csvTools = {
  "csv.parse": defineTool({
    name: "csv.parse",
    description: "Parse a CSV string into rows. Default `hasHeader: true` returns objects keyed by header.",
    inputSchema: csvParseInput,
    outputSchema: csvParseOutput,
    inputExample: { value: "a,b\n1,2", hasHeader: true },
    async execute(input) {
      return { rows: parseCsv(input.value, input.hasHeader ?? true) };
    },
  }),

  "csv.stringify": defineTool({
    name: "csv.stringify",
    description: "Serialise rows to CSV. Provide `header` for object-rows; omit for array-rows.",
    inputSchema: csvStringifyInput,
    outputSchema: csvStringifyOutput,
    inputExample: { rows: [{ a: "1", b: "2" }], header: ["a", "b"] },
    async execute(input) {
      return { value: stringifyCsv(input.rows, input.header) };
    },
  }),

  "csv.filter": defineTool({
    name: "csv.filter",
    description: "Filter object-rows by an exact-match `where` map (every entry must match).",
    inputSchema: csvFilterInput,
    outputSchema: csvFilterOutput,
    inputExample: { rows: [{ id: "1", status: "open" }], where: { status: "open" } },
    async execute(input) {
      return { rows: filterCsv(input.rows, input.where) };
    },
  }),

  "csv.fetch": defineTool({
    name: "csv.fetch",
    description: "Stream a CSV URL row-by-row and return a bounded summary (counts + sample). Use this for multi-MB CSV payloads instead of `http.request` + `csv.parse` — memory stays O(sampleRows).",
    inputSchema: csvFetchInput,
    outputSchema: csvFetchOutput,
    inputExample: { url: "https://example.com/data.csv", sampleRows: 10 },
    // Pure read — no remote mutation. Dry-run sandbox replays exercise
    // this identically to a production run.
    async execute(input) {
      const sampleCap = input.sampleRows ?? 50;
      const maxBytes = input.maxBytes ?? 10 * 1024 * 1024;
      // Outer try/catch turns the SSRF / DNS / pre-check failures
      // (which throw before any stream opens) into a clean
      // `{ ok: false, statusCode: 0 }` envelope. The stream-level
      // failures (mid-stream byte-cap abort, decoder error) flow
      // through `streamCsvSummary`'s catch and surface as
      // `{ ok: false, streamTruncated: true, ... }` with partial counts.
      try {
        const streaming = await fetchHttpTarget(input.url, {
          method: "GET",
          headers: input.headers,
          timeoutMs: input.timeoutMs,
          maxResponseBytes: maxBytes,
          maxRedirects: input.maxRedirects,
          bodyMode: "stream",
        });
        // Even when the response is non-2xx, the body is still streamed
        // (an error payload could be a CSV-shaped error response).
        // Surface the statusCode on the envelope so downstream
        // `condition` nodes can branch on it.
        const summary = await streamCsvSummary(streaming.body, {
          sampleRows: sampleCap,
          filter: input.filter,
        });
        const ok = summary.ok && streaming.ok;
        return {
          ok,
          statusCode: streaming.statusCode,
          totalRows: summary.totalRows,
          matchedRows: summary.matchedRows,
          sampleRows: summary.sampleRows,
          headers: summary.headers,
          streamedBytes: summary.streamedBytes,
          streamTruncated: summary.streamTruncated,
          malformedRows: summary.malformedRows,
          error: summary.error ?? (ok ? undefined : `HTTP ${streaming.statusCode}`),
        };
      } catch (err) {
        // Pre-stream rejection (SSRF / DNS pin / Content-Length cap /
        // unsupported scheme). Return a uniform error envelope so the
        // workflow can branch on `.ok` regardless of which guard fired.
        const message = err instanceof Error ? err.message : "csv fetch failed";
        return {
          ok: false,
          statusCode: 0,
          totalRows: 0,
          matchedRows: 0,
          sampleRows: [],
          headers: [],
          streamedBytes: 0,
          streamTruncated: false,
          malformedRows: 0,
          error: scrubSecretShapes(message).slice(0, 200),
        };
      }
    },
  }),
};

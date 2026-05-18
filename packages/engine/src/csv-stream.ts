/**
 * Streaming CSV consumer — reads a `ReadableStream<Uint8Array>` row-by-row
 * via the shared RFC 4180 parser in `csv.ts`, applies an optional exact-match
 * filter, and returns a bounded summary (total / matched / sample rows +
 * headers + byte counters). Memory bound is `O(sampleRows × avgRowSize)
 * + O(longestLineSize)` — the full payload is NEVER buffered.
 *
 * Used by the `csv.fetch` tool in `tool-registry.ts` to consume a streamed
 * HTTP body returned by `fetchHttpTarget(..., { bodyMode: "stream" })`.
 * The tool wraps the summary in the standard read-tool envelope (adds
 * `statusCode`, etc.) before returning to the workflow runtime.
 *
 * Invariants:
 * - Single returned shape on EVERY path (success, stream error, decoder
 *   error, byte-cap abort). The function does not throw — stream-level
 *   failures land as `{ ok: false, error, streamTruncated: true, ... }`
 *   with whatever partial counts accumulated, so the operator sees what
 *   got through before the abort.
 * - Malformed rows (column count mismatch with header) increment
 *   `malformedRows` but do NOT short-circuit; subsequent rows are still
 *   parsed. The CSV grammar itself (`feedCsvChunk` in `csv.ts`) is
 *   permissive — there's no "syntax error" path at the tokenizer level,
 *   only structural mismatches at this layer.
 * - The first parsed row becomes `headers`. If the stream ends before
 *   any row arrives, `headers: []` and `totalRows: 0`.
 * - `sampleRows` only contains rows that PASSED the filter when one is
 *   set (sample reflects matched rows, never raw stream rows). Without a
 *   filter, every parsed row is "matched" — `matchedRows === totalRows`.
 */

import { scrubSecretShapes } from "@janusly/shared/src/error-signature";

import {
  createCsvParseState,
  feedCsvChunk,
  finalizeCsvParse,
} from "./csv";

/**
 * Bounded summary returned by `streamCsvSummary`. `ok: false` means the
 * underlying stream errored (byte-cap abort, decoder failure, network
 * blip) — partial counts are still populated so the caller surfaces
 * what got through.
 */
export type CsvStreamSummary = {
  ok: boolean;
  /** Present iff `ok: false`. Generic message — the original error's `.message` truncated to 200 chars. */
  error?: string;
  /** Count of data rows seen (excluding the header row). Includes filtered-out + malformed. */
  totalRows: number;
  /** Count of rows that satisfied the filter (or `=== totalRows` when no filter). Excludes malformed. */
  matchedRows: number;
  /** First `min(sampleRows, matchedRows)` matched rows, as objects keyed by header. */
  sampleRows: Array<Record<string, string>>;
  /** Header row tokens, in upstream order. `[]` when the stream produced zero rows. */
  headers: string[];
  /** Total bytes pulled from the upstream stream (capped by the underlying `maxResponseBytes`). */
  streamedBytes: number;
  /** True iff the stream aborted (byte-cap exceeded, decoder failure, etc.) before clean end. */
  streamTruncated: boolean;
  /** Rows whose column count didn't match the header. Counted toward `totalRows` but NOT toward `matchedRows`. */
  malformedRows: number;
};

/**
 * Consume a CSV stream end-to-end (or until the stream errors). Returns a
 * bounded summary; never throws. The tool wrapper in `tool-registry.ts`
 * adds HTTP-level fields (statusCode, ok of the response) on top before
 * returning the workflow envelope.
 *
 * @param stream The body from `fetchHttpTarget(..., { bodyMode: "stream" })`.
 * @param options.sampleRows Max number of matched rows to retain (1..500 enforced by the caller). The cap is what bounds memory.
 * @param options.filter Optional exact-match `Record<string, string>` WHERE clause; rows not matching every entry are skipped.
 */
export async function streamCsvSummary(
  stream: ReadableStream<Uint8Array>,
  options: { sampleRows: number; filter?: Record<string, string> },
): Promise<CsvStreamSummary> {
  const state = createCsvParseState();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const sampleCap = Math.max(1, Math.floor(options.sampleRows));
  const filterEntries = options.filter && Object.keys(options.filter).length > 0
    ? Object.entries(options.filter)
    : null;

  let totalRows = 0;
  let matchedRows = 0;
  let malformedRows = 0;
  let streamedBytes = 0;
  let headers: string[] | null = null;
  const sampleRows: Array<Record<string, string>> = [];

  // Drain a batch of parsed rows from the streaming tokenizer. Pure side
  // effects on the closures above — no return value. Stops collecting
  // sample rows once the cap is hit; matched / total counters keep
  // ticking through the rest of the stream.
  const processRows = (rows: string[][]): void => {
    for (const row of rows) {
      if (headers === null) {
        headers = row;
        continue;
      }
      totalRows += 1;
      if (row.length !== headers.length) {
        // Column-count mismatch — count as malformed and skip without
        // attempting to build an object. The tokenizer never throws,
        // so this is the only structural-error path.
        malformedRows += 1;
        continue;
      }
      // Early skip: when there's no filter and the sample is already
      // full, neither the object nor any per-row allocation is needed.
      // Just bump matchedRows and move on. Keeps memory + GC pressure
      // O(sampleRows × avgRowSize) even on a 10M-row stream.
      if (!filterEntries && sampleRows.length >= sampleCap) {
        matchedRows += 1;
        continue;
      }
      // Build the object-row keyed by header (needed either to
      // evaluate the filter, or to push into the sample, or both).
      const obj: Record<string, string> = {};
      for (let i = 0; i < headers.length; i += 1) {
        obj[headers[i]] = row[i] ?? "";
      }
      // Apply filter if set.
      if (filterEntries) {
        let allMatch = true;
        for (const [key, value] of filterEntries) {
          if (obj[key] !== value) { allMatch = false; break; }
        }
        if (!allMatch) continue;
      }
      matchedRows += 1;
      if (sampleRows.length < sampleCap) sampleRows.push(obj);
    }
  };

  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      // Track raw byte total (pre-decode) so streamedBytes reflects the
      // actual upstream transfer size, not the post-decode character
      // count. The shared `maxResponseBytes` cap on the streaming
      // primitive fires at this same byte boundary.
      streamedBytes += value.byteLength;
      const text = decoder.decode(value, { stream: true });
      if (text.length > 0) processRows(feedCsvChunk(state, text));
    }
    // Flush any trailing bytes the decoder buffered for a multi-byte
    // sequence, then drain a partial trailing row (file without final
    // newline).
    const tail = decoder.decode();
    if (tail.length > 0) processRows(feedCsvChunk(state, tail));
    processRows(finalizeCsvParse(state));
  } catch (err) {
    // Underlying stream / decoder failure. The shared
    // `fetchHttpTarget` byte-cap surfaces as a descriptive Error.
    // Truncate the message defensively so a fragment carrying a URL
    // can't smuggle a path-encoded secret into the persisted envelope
    // — operators debug from `streamedBytes` + the failed-run
    // timeline, not the error text.
    const message = err instanceof Error ? err.message : "stream consumption failed";
    return {
      ok: false,
      error: scrubSecretShapes(message).slice(0, 200),
      totalRows,
      matchedRows,
      sampleRows,
      headers: headers ?? [],
      streamedBytes,
      streamTruncated: true,
      malformedRows,
    };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Releasing a reader on an already-closed stream throws; swallow.
    }
  }

  return {
    ok: true,
    totalRows,
    matchedRows,
    sampleRows,
    headers: headers ?? [],
    streamedBytes,
    streamTruncated: false,
    malformedRows,
  };
}

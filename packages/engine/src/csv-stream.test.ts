import { describe, expect, it } from "vitest";
import { streamCsvSummary } from "./csv-stream";

/**
 * Build a `ReadableStream<Uint8Array>` from a list of string chunks. Each
 * chunk is emitted on its own `read()` so we can pin behavior across
 * chunk boundaries — the critical bit when a CSV row spans two
 * `enqueue()` calls.
 */
function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i]));
      i += 1;
    },
  });
}

/** Convenience: one-shot stream from a single string. */
function streamFromString(value: string): ReadableStream<Uint8Array> {
  return streamFromChunks([value]);
}

describe("streamCsvSummary", () => {
  it("counts every data row, returns headers, and caps the sample at sampleRows", async () => {
    // 1000-row CSV. With sampleRows=10 we expect ten rows in the sample,
    // matchedRows === totalRows === 1000 (no filter), and headers
    // surfaced verbatim.
    const lines = ["id,status,note"];
    for (let i = 1; i <= 1000; i += 1) {
      lines.push(`${i},ACTIVE,row ${i}`);
    }
    const summary = await streamCsvSummary(streamFromString(lines.join("\n")), {
      sampleRows: 10,
    });
    expect(summary.ok).toBe(true);
    expect(summary.totalRows).toBe(1000);
    expect(summary.matchedRows).toBe(1000);
    expect(summary.sampleRows).toHaveLength(10);
    expect(summary.headers).toEqual(["id", "status", "note"]);
    expect(summary.malformedRows).toBe(0);
    expect(summary.streamTruncated).toBe(false);
    // First sample row preserves the cell values keyed by header.
    expect(summary.sampleRows[0]).toEqual({ id: "1", status: "ACTIVE", note: "row 1" });
  });

  it("reconstructs rows that straddle a chunk boundary", async () => {
    // The decoder buffers a partial multi-byte sequence across chunks
    // (`{ stream: true }`); the CSV parser buffers a partial row across
    // chunks (via `feedCsvChunk`'s state). Both have to compose
    // correctly. We split a single logical row across two chunks at an
    // arbitrary byte boundary — the parser must produce the row intact.
    const stream = streamFromChunks([
      "id,name\n1,al",       // chunk 1 ends mid-row, mid-field
      "ice\n2,bob",          // chunk 2 completes row 1 + starts row 2 (no trailing \n)
    ]);
    const summary = await streamCsvSummary(stream, { sampleRows: 10 });
    expect(summary.ok).toBe(true);
    expect(summary.totalRows).toBe(2);
    expect(summary.headers).toEqual(["id", "name"]);
    expect(summary.sampleRows).toEqual([
      { id: "1", name: "alice" },
      { id: "2", name: "bob" },
    ]);
  });

  it("reconstructs escaped quotes that straddle a chunk boundary", async () => {
    const stream = streamFromChunks([
      'id,note\n1,"she said "',
      '"hi"""',
    ]);
    const summary = await streamCsvSummary(stream, { sampleRows: 10 });
    expect(summary.ok).toBe(true);
    expect(summary.totalRows).toBe(1);
    expect(summary.sampleRows).toEqual([
      { id: "1", note: 'she said "hi"' },
    ]);
  });

  it("treats CRLF split across chunks as one row break", async () => {
    const stream = streamFromChunks([
      "id,name\r",
      "\n1,alice\r",
      "\n2,bob",
    ]);
    const summary = await streamCsvSummary(stream, { sampleRows: 10 });
    expect(summary.ok).toBe(true);
    expect(summary.totalRows).toBe(2);
    expect(summary.sampleRows).toEqual([
      { id: "1", name: "alice" },
      { id: "2", name: "bob" },
    ]);
  });

  it("applies the filter exact-match — matchedRows + sample reflect WHERE", async () => {
    // 5 rows total, 2 should match `{ status: "ACTIVE" }`. The sample is
    // matched rows only (never raw stream rows), and matchedRows is
    // those rows' count.
    const csv = [
      "id,status",
      "1,ACTIVE",
      "2,inactive",
      "3,ACTIVE",
      "4,inactive",
      "5,deleted",
    ].join("\n");
    const summary = await streamCsvSummary(streamFromString(csv), {
      sampleRows: 50,
      filter: { status: "ACTIVE" },
    });
    expect(summary.ok).toBe(true);
    expect(summary.totalRows).toBe(5);
    expect(summary.matchedRows).toBe(2);
    expect(summary.sampleRows).toEqual([
      { id: "1", status: "ACTIVE" },
      { id: "3", status: "ACTIVE" },
    ]);
  });

  it("counts malformed rows (column-count mismatch) and continues parsing", async () => {
    // Row 2 has 2 cells where the header declares 3 columns — counts as
    // malformed but the subsequent rows still parse. Note: the
    // tokenizer itself is permissive (no syntax-error path); this is
    // the structural-mismatch check that lives in csv-stream.ts.
    const csv = [
      "id,name,status",
      "1,alice,ACTIVE",     // ok
      "2,bob",              // malformed: column count mismatch
      "3,carol,ACTIVE",     // ok
    ].join("\n");
    const summary = await streamCsvSummary(streamFromString(csv), {
      sampleRows: 50,
    });
    expect(summary.ok).toBe(true);
    expect(summary.totalRows).toBe(3);          // includes malformed
    expect(summary.matchedRows).toBe(2);        // excludes malformed
    expect(summary.malformedRows).toBe(1);
    expect(summary.sampleRows.map((r) => r.id)).toEqual(["1", "3"]);
  });

  it("drains a trailing row when the stream ends without a final newline", async () => {
    // A common producer omits the final `\n`. The parser's
    // `finalizeCsvParse` is the codepath that flushes that last partial
    // row — pin it here so a regression in the refactor surfaces fast.
    const csv = "id,name\n1,alice"; // no trailing newline
    const summary = await streamCsvSummary(streamFromString(csv), {
      sampleRows: 10,
    });
    expect(summary.ok).toBe(true);
    expect(summary.totalRows).toBe(1);
    expect(summary.sampleRows).toEqual([{ id: "1", name: "alice" }]);
  });

  it("returns a JSON-safe envelope with no live ReadableStream leaked", async () => {
    // Stream-leak chokepoint: the persisted `state_json` for an
    // `mcp_tool` / tool node call MUST be plain JSON. If a future bug
    // accidentally piped the raw stream into `sampleRows`, the
    // round-trip below would either lose data or throw. Round-tripping
    // through JSON.stringify/parse here is the cheapest assertion of
    // "the envelope is safe to persist".
    const csv = "id,name\n1,alice\n2,bob";
    const summary = await streamCsvSummary(streamFromString(csv), {
      sampleRows: 10,
    });
    const roundtripped = JSON.parse(JSON.stringify(summary));
    expect(roundtripped).toEqual(summary);
    expect(roundtripped.sampleRows[0]).toEqual({ id: "1", name: "alice" });
    // Defense in depth: assert no `__stream` sentinel anywhere — that's
    // what `safePersistPayload` would inject if it caught a leak.
    expect(JSON.stringify(summary)).not.toContain("__stream");
  });

  it("surfaces ok:false + streamTruncated:true with partial counts on a mid-stream abort", async () => {
    // Simulate a byte-cap abort or network blip by ENQUEUING good
    // chunks then ERRORING the controller mid-stream. The parser
    // accumulates the rows that arrived before the error and returns
    // `ok: false` with `streamTruncated: true` + the partial sample.
    let i = 0;
    const lines = ["id,name", "1,alice", "2,bob", "3,carol"];
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < 3) {
          // First three pulls: header + first two rows.
          controller.enqueue(new TextEncoder().encode(lines[i] + "\n"));
          i += 1;
          return;
        }
        // Fourth pull: error out before the last row arrives.
        controller.error(new Error("response body exceeded maxBytes"));
      },
    });
    const summary = await streamCsvSummary(stream, { sampleRows: 10 });
    expect(summary.ok).toBe(false);
    expect(summary.streamTruncated).toBe(true);
    expect(summary.error).toMatch(/maxBytes/);
    expect(summary.totalRows).toBe(2);   // rows that arrived before abort
    expect(summary.sampleRows).toEqual([
      { id: "1", name: "alice" },
      { id: "2", name: "bob" },
    ]);
  });
});

/**
 * Hand-rolled RFC 4180 (subset) CSV helpers — parse, stringify, filter.
 * Backs the `csv.parse`, `csv.stringify`, `csv.filter` tool-registry entries.
 *
 * Why hand-rolled: the npm `csv-parse` package is ~70 KB and exposes a
 * Streams API our small workflow values don't need. The supported grammar
 * here is intentionally tight:
 *
 * - Comma separator, CRLF or LF line terminators.
 * - Quoted fields wrapped in `"..."`. Inside a quoted field, `""` is the
 *   escape for a literal `"`. Quoted fields may contain commas and
 *   newlines.
 * - No comment lines, no escape character outside the `""` form, no
 *   custom delimiter, no encoding handling (the input is already a JS
 *   string).
 *
 * Used by `tool-registry.ts` (`csv.parse`, `csv.stringify`, `csv.filter`).
 *
 * Invariants:
 * - All three functions are pure — no I/O, no mutation of inputs.
 * - `parseCsv` strips a UTF-8 BOM if present so callers don't have to
 *   special-case it.
 * - `stringifyCsv` is the inverse of `parseCsv` for round-trippable inputs
 *   (no embedded NULs, no leading/trailing whitespace inside quoted
 *   fields). Tests pin the round-trip identity.
 */

const BOM = "﻿";

/**
 * Parse a CSV string into rows. With `hasHeader: true` (default), the first
 * row is treated as field names and each subsequent row becomes a
 * `Record<string, string>`. Without a header, every row is a `string[]`.
 */
export function parseCsv(input: string, hasHeader = true): Array<Record<string, string>> | string[][] {
  const stripped = input.startsWith(BOM) ? input.slice(BOM.length) : input;
  const rows = parseRows(stripped);
  if (rows.length === 0) return [];
  if (!hasHeader) return rows;
  const [header, ...body] = rows;
  return body.map((row) => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) {
      obj[header[i]] = row[i] ?? "";
    }
    return obj;
  });
}

/**
 * Render a list of rows back to a CSV string. When `header` is provided,
 * it's emitted as the first row and the rows are object-typed; otherwise
 * the rows are arrays and emitted verbatim. A field is quoted when it
 * contains a comma, double-quote, CR, or LF.
 */
export function stringifyCsv(
  rows: Array<Record<string, string | number | boolean | null | undefined>> | Array<Array<string | number | boolean | null | undefined>>,
  header?: string[],
): string {
  if (rows.length === 0) return header ? header.map(quoteField).join(",") : "";

  if (header) {
    const objRows = rows as Array<Record<string, string | number | boolean | null | undefined>>;
    const lines = [header.map(quoteField).join(",")];
    for (const row of objRows) {
      lines.push(header.map((key) => quoteField(formatCell(row[key]))).join(","));
    }
    return lines.join("\n");
  }

  const arrRows = rows as Array<Array<string | number | boolean | null | undefined>>;
  return arrRows.map((row) => row.map((cell) => quoteField(formatCell(cell))).join(",")).join("\n");
}

/**
 * Filter object-rows by an exact-match `where` map. Every entry in `where`
 * must equal the row's column value (string compare); rows whose column
 * is missing fail to match.
 */
export function filterCsv(
  rows: Array<Record<string, string>>,
  where: Record<string, string>,
): Array<Record<string, string>> {
  const entries = Object.entries(where);
  if (entries.length === 0) return rows;
  return rows.filter((row) => entries.every(([key, value]) => row[key] === value));
}

/**
 * Mutable parser state. Carries the in-flight row + field + inQuotes flag
 * across chunks. Streaming consumers (e.g. `csv-stream.ts`) hold one of
 * these and call `feedCsvChunk` repeatedly; the buffered `parseRows` below
 * is a thin wrapper that initialises a state, feeds the full input, and
 * finalises in one shot.
 *
 * Field-spanning quotes is the whole reason a per-line tokenizer wouldn't
 * work: a quoted field can contain embedded newlines (RFC 4180), so a
 * row's logical boundary isn't a `\n` outside quotes — only the parser's
 * state can decide where a row ends.
 */
export type CsvParseState = {
  row: string[];
  field: string;
  inQuotes: boolean;
  pendingQuote: boolean;
  pendingCr: boolean;
};

/** Fresh streaming parser state. */
export function createCsvParseState(): CsvParseState {
  return { row: [], field: "", inQuotes: false, pendingQuote: false, pendingCr: false };
}

/**
 * Feed a chunk of CSV text into a streaming parser. Mutates `state` in
 * place; returns any rows that finished inside this chunk. Call repeatedly
 * with successive chunks (no constraint on chunk boundary alignment with
 * row / line breaks), then call `finalizeCsvParse(state)` at end-of-stream
 * to drain any partial trailing row.
 *
 * Strips a leading UTF-8 BOM from the very first feed.
 */
export function feedCsvChunk(state: CsvParseState, input: string): string[][] {
  // BOM only ever appears at the start of the whole stream — strip on the
  // first chunk that has any content (caller passes through chunks
  // verbatim from the decoder).
  let i = 0;
  if (
    state.row.length === 0
    && state.field.length === 0
    && !state.inQuotes
    && !state.pendingQuote
    && !state.pendingCr
    && input.startsWith(BOM)
  ) {
    i = BOM.length;
  }
  const rows: string[][] = [];

  while (i < input.length) {
    if (state.pendingCr) {
      state.pendingCr = false;
      if (input[i] === "\n") {
        i += 1;
        continue;
      }
    }

    if (state.pendingQuote) {
      if (input[i] === '"') {
        state.field += '"';
        state.pendingQuote = false;
        i += 1;
        continue;
      }
      state.pendingQuote = false;
      state.inQuotes = false;
      continue;
    }

    const ch = input[i];

    if (state.inQuotes) {
      if (ch === '"') {
        if (i + 1 >= input.length) {
          state.pendingQuote = true;
          i += 1;
          continue;
        }
        if (input[i + 1] === '"') {
          // Escaped quote inside a quoted field.
          state.field += '"';
          i += 2;
          continue;
        }
        state.inQuotes = false;
        i += 1;
        continue;
      }
      state.field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      state.inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      state.row.push(state.field);
      state.field = "";
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      state.row.push(state.field);
      rows.push(state.row);
      state.row = [];
      state.field = "";
      // Consume CRLF as a single line break.
      if (ch === "\r" && input[i + 1] === "\n") i += 2;
      else {
        i += 1;
        if (ch === "\r" && i >= input.length) state.pendingCr = true;
      }
      continue;
    }
    state.field += ch;
    i += 1;
  }

  return rows;
}

/**
 * Drain a partial trailing row at end-of-stream. Returns `[]` when the
 * input ended cleanly on a newline; returns `[lastRow]` when there's a
 * non-empty trailing field or row.
 */
export function finalizeCsvParse(state: CsvParseState): string[][] {
  if (state.pendingQuote) {
    state.pendingQuote = false;
    state.inQuotes = false;
  }
  state.pendingCr = false;

  if (state.field.length > 0 || state.row.length > 0) {
    state.row.push(state.field);
    const out = [state.row];
    state.row = [];
    state.field = "";
    return out;
  }
  return [];
}

/* -------- internals -------- */

function parseRows(input: string): string[][] {
  // Thin wrapper around the streaming primitives. Behavior is identical
  // to the original character-by-character implementation that lived here
  // — the tests pin that.
  const state = createCsvParseState();
  const fed = feedCsvChunk(state, input);
  const tail = finalizeCsvParse(state);
  return tail.length > 0 ? [...fed, ...tail] : fed;
}

function formatCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function quoteField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

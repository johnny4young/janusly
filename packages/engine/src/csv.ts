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
  if (rows.length === 0) return hasHeader ? [] : [];
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

/* -------- internals -------- */

function parseRows(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          // Escaped quote inside a quoted field.
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      // Consume CRLF as a single line break.
      if (ch === "\r" && input[i + 1] === "\n") i += 2;
      else i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  // Tail field / row. Skip emitting an empty trailing row when the input
  // ends with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
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

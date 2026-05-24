/**
 * Markdown + HTML → PDF renderer for the `pdf.generate` tool. Pure-Node,
 * no Chromium / puppeteer / hosted service. Uses `pdfkit` programmatically.
 *
 * Two input formats are supported, selected by the tool's `format` field:
 *
 *   - **Markdown** (default): heading levels 1-3, paragraphs with bold
 *     (`**…**`) and italic (`*…*`) inline runs, bulleted (`-` / `*`) and
 *     numbered (`1.`) lists, fenced code blocks (```` ``` ````), and `---`
 *     horizontal rules.
 *   - **HTML**: a closed, sanitized subset parsed via `htmlparser2`. The
 *     whitelist covers `<h1>`–`<h6>`, `<p>`, `<div>`, `<br>`, `<ul>`, `<ol>`,
 *     `<li>`, `<hr>`, `<pre>`, `<code>`, `<strong>`/`<b>`, `<em>`/`<i>`,
 *     `<span>`, `<a href>` (http/https only), and `<table>` / `<thead>` /
 *     `<tbody>` / `<tr>` / `<th>` / `<td>` (with bounded `colspan`). The
 *     deny-set drops both the tag AND its children: `<script>`, `<style>`,
 *     `<iframe>`, `<object>`, `<embed>`, `<link>`, `<meta>`, `<base>`,
 *     `<form>`, `<input>`, `<img>`, `<svg>`. Unknown tags pass children
 *     through. All `on*` event-handler attributes and inline `style="…"` are
 *     dropped. `<a href>` is validated as http/https — `javascript:` and
 *     other schemes drop the href and render the anchor text as plain.
 *
 * Variable substitution: `{{varName}}` placeholders in the template are
 * replaced verbatim from the caller-supplied `variables` map BEFORE
 * parsing (applies to both formats). Unknown placeholders are left intact
 * and surface in the rendered PDF (intentional — operators see the typo
 * immediately rather than getting a silent empty cell).
 *
 * Used by `packages/engine/src/tool-registry.ts:pdf.generate`.
 *
 * Invariants:
 * - `renderMarkdownToPdf` and `renderHtmlToPdf` resolve to a `Buffer`. They
 *   throw on truly exceptional cases (template too large, nesting too deep,
 *   pdfkit error). The tool wrapper translates throws into the standard
 *   `{ ok: false, error }` envelope.
 * - The renderers NEVER read the filesystem, network, or process env. All
 *   inputs come through the function arguments, so they're trivially safe
 *   to call from any context (worker, api, sandbox).
 */

import PDFDocument from "pdfkit";
import { Parser } from "htmlparser2";
import {
  MAX_BLOCKS,
  MAX_TOKENS_PER_BLOCK,
  parseMarkdownBlocks,
  substituteVariables,
  type Block,
  type InlineStyle,
  type InlineToken,
  type TableCell,
} from "@janusly/shared/src/markdown-subset";

// Re-export the hoisted symbols so existing consumers (and the colocated
// test file) keep their import paths. The runtime + behavior come from
// `@janusly/shared/src/markdown-subset`.
export { parseMarkdownBlocks, substituteVariables };
export type { Block, InlineStyle, InlineToken, TableCell };

/* --------------------------------- public --------------------------------- */

export type RenderMarkdownToPdfInput = {
  /** Raw Markdown source. Variables are substituted before parsing. */
  template: string;
  /** Optional `{{name}}` substitutions. Coerced to string at render time. */
  variables?: Record<string, string | number | boolean>;
  /** PDF document title — populated in the file's metadata block. */
  title?: string;
};

export type RenderMarkdownToPdfResult = {
  buffer: Buffer;
  contentLength: number;
};

export type RenderHtmlToPdfInput = {
  /** Raw HTML source. Variables are substituted before parsing. */
  template: string;
  /** Optional `{{name}}` substitutions. Coerced to string at render time. */
  variables?: Record<string, string | number | boolean>;
  /** PDF document title — populated in the file's metadata block. */
  title?: string;
};

export type RenderHtmlToPdfResult = {
  buffer: Buffer;
  contentLength: number;
};

const MAX_TEMPLATE_BYTES = 200_000;
const MAX_HTML_NEST_DEPTH = 32;
const MAX_TABLE_COLSPAN = 16;

export async function renderMarkdownToPdf(input: RenderMarkdownToPdfInput): Promise<RenderMarkdownToPdfResult> {
  enforceTemplateSize(input.template);
  const interpolated = substituteVariables(input.template, input.variables);
  enforceTemplateSize(interpolated);
  const blocks = parseMarkdownBlocks(interpolated);
  return renderBlocksToPdf(blocks, input.title);
}

export async function renderHtmlToPdf(input: RenderHtmlToPdfInput): Promise<RenderHtmlToPdfResult> {
  enforceTemplateSize(input.template);
  const interpolated = substituteVariables(input.template, input.variables);
  enforceTemplateSize(interpolated);
  const blocks = parseAndSanitizeHtml(interpolated);
  return renderBlocksToPdf(blocks, input.title);
}

function enforceTemplateSize(template: string): void {
  if (Buffer.byteLength(template, "utf8") > MAX_TEMPLATE_BYTES) {
    throw new Error(`pdf template exceeds ${MAX_TEMPLATE_BYTES} bytes`);
  }
}

async function renderBlocksToPdf(blocks: Block[], title: string | undefined): Promise<{ buffer: Buffer; contentLength: number }> {
  const doc = new PDFDocument({
    size: "A4",
    margin: 56,
    info: { Title: title ?? "Janusly PDF" },
  });

  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolveFinished, rejectFinished) => {
    doc.on("end", () => resolveFinished());
    doc.on("error", (err) => rejectFinished(err));
  });

  renderBlocks(doc, blocks);
  doc.end();
  await finished;

  const buffer = Buffer.concat(chunks);
  return { buffer, contentLength: buffer.length };
}

/* ----------------------------- HTML walker ------------------------------- */

/** Closed whitelist of block-level HTML tags. Documentation surface for
 *  operators / LLM-emitted templates; the walker matches each tag by name
 *  in its switch statement so this set is exported for test parity checks. */
export const HTML_BLOCK_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "div",
  "ul", "ol", "li",
  "hr", "pre",
  "table", "thead", "tbody", "tr", "th", "td",
]);

export const HTML_INLINE_TAGS = new Set([
  "strong", "b", "em", "i", "code", "span", "a", "br",
]);

/** Closed deny-set: tag AND its children are dropped from the output. */
const HTML_DROP_TAGS = new Set([
  "script", "style", "iframe", "object", "embed",
  "link", "meta", "base", "form", "input", "img", "svg",
]);

/** Exported for tests; parametric assertion that every deny-tag is dropped. */
export const HTML_DROP_TAGS_LIST: readonly string[] = Array.from(HTML_DROP_TAGS);

/**
 * Parse + sanitize an HTML source string into the renderer's `Block[]`
 * intermediate representation. Exported so tests can assert on the AST
 * shape directly (PDF content streams are Flate-compressed by default, so
 * byte inspection of the rendered buffer is not a useful test surface).
 */
export function parseAndSanitizeHtml(source: string): Block[] {
  const blocks: Block[] = [];

  let dropDepth = 0;
  let openDepth = 0;

  let boldDepth = 0;
  let italicDepth = 0;
  let codeDepth = 0;
  const linkHrefStack: string[] = [];

  let pendingParagraph: InlineToken[] | null = null;
  let pendingHeading: { level: 1 | 2 | 3 | 4 | 5 | 6; tokens: InlineToken[] } | null = null;
  let pendingPreLines: string[] | null = null;

  let pendingList: { ordered: boolean; items: InlineToken[][] } | null = null;
  let pendingLi: InlineToken[] | null = null;

  type PendingTable = {
    rows: TableCell[][];
    headerRowCount: number;
    inThead: boolean;
    currentRow: TableCell[] | null;
    currentCell: TableCell | null;
  };
  let pendingTable: PendingTable | null = null;

  function currentStyle(): InlineStyle {
    if (codeDepth > 0) return "code";
    if (boldDepth > 0) return "bold";
    if (italicDepth > 0) return "italic";
    return "plain";
  }

  function currentLinkHref(): string | null {
    if (linkHrefStack.length === 0) return null;
    const top = linkHrefStack[linkHrefStack.length - 1];
    return top === "" ? null : top;
  }

  function makeToken(text: string): InlineToken {
    const href = currentLinkHref();
    if (href !== null) return { text, style: "link", href };
    return { text, style: currentStyle() };
  }

  function appendToken(target: InlineToken[], token: InlineToken): void {
    if (target.length >= MAX_TOKENS_PER_BLOCK) {
      throw new Error(`pdf template exceeds ${MAX_TOKENS_PER_BLOCK} inline tokens in one block`);
    }
    target.push(token);
  }

  function pushInline(token: InlineToken): void {
    if (pendingTable && pendingTable.currentCell) {
      appendToken(pendingTable.currentCell.tokens, token);
      return;
    }
    if (pendingLi !== null) {
      appendToken(pendingLi, token);
      return;
    }
    if (pendingHeading !== null) {
      appendToken(pendingHeading.tokens, token);
      return;
    }
    if (pendingParagraph !== null) {
      appendToken(pendingParagraph, token);
      return;
    }
    pendingParagraph = [token];
  }

  function pushBlock(block: Block): void {
    if (blocks.length >= MAX_BLOCKS) {
      throw new Error(`pdf template exceeds ${MAX_BLOCKS} block elements`);
    }
    blocks.push(block);
  }

  function emitText(rawText: string): void {
    if (dropDepth > 0) return;
    if (rawText === "") return;
    if (pendingPreLines !== null) {
      pendingPreLines[pendingPreLines.length - 1] += rawText;
      return;
    }
    const collapsed = collapseHtmlWhitespace(rawText);
    if (collapsed === "") return;
    pushInline(makeToken(collapsed));
  }

  function flushParagraph(): void {
    if (pendingParagraph !== null && pendingParagraph.length > 0) {
      pushBlock({ kind: "paragraph", tokens: pendingParagraph });
    }
    pendingParagraph = null;
  }

  function flushHeading(): void {
    if (pendingHeading !== null && pendingHeading.tokens.length > 0) {
      pushBlock({ kind: "heading", level: pendingHeading.level, tokens: pendingHeading.tokens });
    }
    pendingHeading = null;
  }

  function flushPre(): void {
    if (pendingPreLines !== null) {
      const lines = pendingPreLines.join("\n").split("\n");
      pushBlock({ kind: "code", lines });
    }
    pendingPreLines = null;
  }

  function flushList(): void {
    if (pendingList !== null && pendingList.items.length > 0) {
      pushBlock({ kind: "list", ordered: pendingList.ordered, items: pendingList.items });
    }
    pendingList = null;
    pendingLi = null;
  }

  function flushTable(): void {
    if (pendingTable !== null && pendingTable.rows.length > 0) {
      pushBlock({
        kind: "table",
        rows: pendingTable.rows,
        headerRowCount: pendingTable.headerRowCount,
      });
    }
    pendingTable = null;
  }

  function flushBlockContext(): void {
    flushParagraph();
    flushHeading();
    flushPre();
  }

  const parser = new Parser(
    {
      onopentag(rawName, attrs) {
        const tag = rawName.toLowerCase();

        if (HTML_DROP_TAGS.has(tag)) {
          dropDepth += 1;
          return;
        }
        if (dropDepth > 0) return;

        openDepth += 1;
        if (openDepth > MAX_HTML_NEST_DEPTH) {
          throw new Error(`html nesting depth exceeds ${MAX_HTML_NEST_DEPTH}`);
        }

        if (HTML_INLINE_TAGS.has(tag)) {
          switch (tag) {
            case "strong":
            case "b":
              boldDepth += 1;
              return;
            case "em":
            case "i":
              italicDepth += 1;
              return;
            case "code":
              codeDepth += 1;
              return;
            case "span":
              return;
            case "br":
              // Inside <pre>, <br> opens a new line in the existing
              // preformatted block instead of starting a stray paragraph.
              if (pendingPreLines !== null) {
                pendingPreLines.push("");
                return;
              }
              pushInline(makeToken("\n"));
              return;
            case "a": {
              const href = typeof attrs.href === "string" ? attrs.href : null;
              const safe = href !== null && /^https?:\/\//i.test(href.trim()) ? href.trim() : null;
              linkHrefStack.push(safe ?? "");
              return;
            }
          }
          return;
        }

        switch (tag) {
          case "h1":
          case "h2":
          case "h3":
          case "h4":
          case "h5":
          case "h6": {
            flushBlockContext();
            const level = Number(tag[1]) as 1 | 2 | 3 | 4 | 5 | 6;
            pendingHeading = { level, tokens: [] };
            return;
          }
          case "p":
          case "div": {
            flushBlockContext();
            pendingParagraph = pendingParagraph ?? [];
            return;
          }
          case "hr":
            flushBlockContext();
            pushBlock({ kind: "rule" });
            return;
          case "pre":
            flushBlockContext();
            pendingPreLines = [""];
            return;
          case "ul":
          case "ol":
            flushBlockContext();
            pendingList = { ordered: tag === "ol", items: [] };
            return;
          case "li":
            if (pendingList === null) {
              flushBlockContext();
              pendingList = { ordered: false, items: [] };
            }
            pendingLi = [];
            return;
          case "table":
            flushBlockContext();
            pendingTable = {
              rows: [],
              headerRowCount: 0,
              inThead: false,
              currentRow: null,
              currentCell: null,
            };
            return;
          case "thead":
            if (pendingTable !== null) pendingTable.inThead = true;
            return;
          case "tbody":
            if (pendingTable !== null) pendingTable.inThead = false;
            return;
          case "tr":
            if (pendingTable !== null) pendingTable.currentRow = [];
            return;
          case "th":
          case "td": {
            if (pendingTable === null || pendingTable.currentRow === null) return;
            const rawColspan = typeof attrs.colspan === "string" ? Number.parseInt(attrs.colspan, 10) : 1;
            const colspan = Number.isFinite(rawColspan) && rawColspan > 0
              ? Math.min(Math.floor(rawColspan), MAX_TABLE_COLSPAN)
              : 1;
            pendingTable.currentCell = { tokens: [], isHeader: tag === "th", colspan };
            return;
          }
        }
      },

      ontext(text) {
        emitText(text);
      },

      onclosetag(rawName) {
        const tag = rawName.toLowerCase();

        if (HTML_DROP_TAGS.has(tag)) {
          if (dropDepth > 0) dropDepth -= 1;
          return;
        }
        if (dropDepth > 0) return;

        if (openDepth > 0) openDepth -= 1;

        if (HTML_INLINE_TAGS.has(tag)) {
          switch (tag) {
            case "strong":
            case "b":
              if (boldDepth > 0) boldDepth -= 1;
              return;
            case "em":
            case "i":
              if (italicDepth > 0) italicDepth -= 1;
              return;
            case "code":
              if (codeDepth > 0) codeDepth -= 1;
              return;
            case "a":
              if (linkHrefStack.length > 0) linkHrefStack.pop();
              return;
            case "span":
            case "br":
              return;
          }
          return;
        }

        switch (tag) {
          case "h1":
          case "h2":
          case "h3":
          case "h4":
          case "h5":
          case "h6":
            flushHeading();
            return;
          case "p":
          case "div":
            flushParagraph();
            return;
          case "pre":
            flushPre();
            return;
          case "ul":
          case "ol":
            flushList();
            return;
          case "li":
            if (pendingList !== null && pendingLi !== null) {
              pendingList.items.push(pendingLi);
              pendingLi = null;
            }
            return;
          case "table":
            flushTable();
            return;
          case "thead":
            if (pendingTable !== null) pendingTable.inThead = false;
            return;
          case "tbody":
            return;
          case "tr":
            if (pendingTable !== null && pendingTable.currentRow !== null) {
              if (pendingTable.inThead) pendingTable.headerRowCount += 1;
              pendingTable.rows.push(pendingTable.currentRow);
              pendingTable.currentRow = null;
            }
            return;
          case "th":
          case "td":
            if (pendingTable !== null && pendingTable.currentRow !== null && pendingTable.currentCell !== null) {
              pendingTable.currentRow.push(pendingTable.currentCell);
              pendingTable.currentCell = null;
            }
            return;
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true }
  );

  parser.write(source);
  parser.end();

  flushParagraph();
  flushHeading();
  flushPre();
  flushList();
  flushTable();

  return blocks;
}

/** HTML whitespace rule: collapse internal whitespace runs to a single space. */
function collapseHtmlWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

/* ------------------------------ pdf rendering ----------------------------- */

const HEADING_SIZES: Record<1 | 2 | 3 | 4 | 5 | 6, number> = { 1: 22, 2: 17, 3: 14, 4: 12, 5: 11, 6: 10 };
const BODY_FONT = "Helvetica";
const BODY_BOLD = "Helvetica-Bold";
const BODY_ITALIC = "Helvetica-Oblique";
const MONO_FONT = "Courier";
const LINK_COLOR = "#0050B3";
const RULE_COLOR = "#cccccc";

function renderBlocks(doc: PDFKit.PDFDocument, blocks: Block[]): void {
  for (const block of blocks) {
    switch (block.kind) {
      case "heading":
        renderHeadingBlock(doc, block.level, block.tokens);
        break;
      case "paragraph":
        doc.font(BODY_FONT).fontSize(11);
        renderInlineTokens(doc, block.tokens);
        doc.moveDown(0.5);
        break;
      case "list": {
        doc.font(BODY_FONT).fontSize(11);
        block.items.forEach((tokens, index) => {
          const bullet = block.ordered ? `${index + 1}. ` : "• ";
          doc.text(bullet, { continued: true });
          renderInlineTokens(doc, tokens);
        });
        doc.moveDown(0.5);
        break;
      }
      case "rule":
        doc.moveDown(0.3);
        doc
          .strokeColor(RULE_COLOR)
          .lineWidth(0.5)
          .moveTo(doc.x, doc.y)
          .lineTo(doc.x + doc.page.width - doc.page.margins.left - doc.page.margins.right, doc.y)
          .stroke();
        doc.moveDown(0.6);
        break;
      case "code":
        doc.font(MONO_FONT).fontSize(10).text(block.lines.join("\n"), { paragraphGap: 6 });
        break;
      case "table":
        renderTableBlock(doc, block);
        break;
    }
  }
}

/**
 * Render a heading block at the heading's font size. Inline links inside a
 * heading retain the link href + link color so the PDF gets a clickable
 * annotation; bold / italic / code style discriminants are ignored within
 * the heading (already bold + heading-size).
 */
function renderHeadingBlock(doc: PDFKit.PDFDocument, level: 1 | 2 | 3 | 4 | 5 | 6, tokens: InlineToken[]): void {
  doc.font(BODY_BOLD).fontSize(HEADING_SIZES[level]);
  if (tokens.length === 0) {
    doc.text("", { paragraphGap: 6 });
    return;
  }
  tokens.forEach((token, index) => {
    const isLast = index === tokens.length - 1;
    if (token.style === "link") doc.fillColor(LINK_COLOR);
    else doc.fillColor("black");
    const opts: { continued: boolean; paragraphGap?: number; link?: string; underline?: boolean } = {
      continued: !isLast,
    };
    if (isLast) opts.paragraphGap = 6;
    if (token.style === "link") {
      opts.link = token.href;
      opts.underline = true;
    }
    doc.text(token.text, opts);
  });
  doc.fillColor("black");
}

/** Render an inline run from typed tokens. Used by paragraph + list. */
function renderInlineTokens(doc: PDFKit.PDFDocument, tokens: InlineToken[]): void {
  if (tokens.length === 0) {
    doc.font(BODY_FONT).text("", { continued: false });
    return;
  }
  tokens.forEach((token, index) => {
    const isLast = index === tokens.length - 1;
    if (token.style === "bold") doc.font(BODY_BOLD).fillColor("black");
    else if (token.style === "italic") doc.font(BODY_ITALIC).fillColor("black");
    else if (token.style === "code") doc.font(MONO_FONT).fillColor("black");
    else if (token.style === "link") doc.font(BODY_FONT).fillColor(LINK_COLOR);
    else doc.font(BODY_FONT).fillColor("black");

    const opts: { continued: boolean; link?: string; underline?: boolean } = { continued: !isLast };
    if (token.style === "link") {
      opts.link = token.href;
      opts.underline = true;
    }
    doc.text(token.text, opts);
  });
  doc.font(BODY_FONT).fillColor("black");
}

/**
 * Render a `<table>` block. Column widths are computed evenly across the
 * usable page width; `colspan` expands a cell across its share. Header
 * rows (`<thead>` rows OR rows where every cell is a `<th>`) render bold.
 * A 0.3pt rule separates each row.
 */
function renderTableBlock(doc: PDFKit.PDFDocument, block: { rows: TableCell[][]; headerRowCount: number }): void {
  if (block.rows.length === 0) return;

  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const totalColumns = computeTableColumnCount(block.rows);
  if (totalColumns === 0) return;
  const colWidth = usableWidth / totalColumns;

  const cellPadX = 4;
  const cellPadY = 3;
  const lineHeight = 14;
  const rowGap = 4;

  doc.moveDown(0.3);
  const leftX = doc.page.margins.left;

  const isImplicitHeader = (row: TableCell[]): boolean =>
    row.length > 0 && row.every((cell) => cell.isHeader);

  for (let rowIdx = 0; rowIdx < block.rows.length; rowIdx += 1) {
    const row = block.rows[rowIdx];
    const isHeaderRow = rowIdx < block.headerRowCount || isImplicitHeader(row);

    const startY = doc.y;
    let colCursor = 0;

    for (const cell of row) {
      const spanCount = Math.max(1, cell.colspan);
      const cellLeft = leftX + colCursor * colWidth;
      const cellWidth = colWidth * spanCount;

      doc
        .font(isHeaderRow ? BODY_BOLD : BODY_FONT)
        .fontSize(10)
        .fillColor("black")
        .text(cellTextPreview(cell), cellLeft + cellPadX, startY + cellPadY, {
          width: cellWidth - 2 * cellPadX,
          lineGap: 2,
        });

      colCursor += spanCount;
    }

    const rowEndY = doc.y + cellPadY;
    const renderedHeight = Math.max(rowEndY - startY, lineHeight + 2 * cellPadY);
    doc.y = startY + renderedHeight;

    doc
      .strokeColor(RULE_COLOR)
      .lineWidth(0.3)
      .moveTo(leftX, doc.y)
      .lineTo(leftX + usableWidth, doc.y)
      .stroke();

    doc.y += rowGap;
    doc.x = leftX;
  }

  doc.fillColor("black");
  doc.moveDown(0.4);
}

function computeTableColumnCount(rows: TableCell[][]): number {
  let max = 0;
  for (const row of rows) {
    let count = 0;
    for (const cell of row) count += Math.max(1, cell.colspan);
    if (count > max) max = count;
  }
  return max;
}

/**
 * Inline tokens inside table cells render as a flat concatenated string in
 * v1 — styled cell content (bold, links) is deferred until table rendering
 * grows wrapping + per-token positioning. Operators who need styled cells
 * should use the outer document's HTML/Markdown features around the table.
 */
function cellTextPreview(cell: TableCell): string {
  return cell.tokens.map((t) => t.text).join("");
}
